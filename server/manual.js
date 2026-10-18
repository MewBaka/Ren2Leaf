// Manual capture: the migrator plays a clone of the game and presses F9 on each screen worth
// porting, then types what it is for. The runtime side is the "manual" mode of
// capture/_ren2leaf_capture.rpy; the safety rules are the capture step's (trust first, a clone,
// saves in the work directory, sandbox-exec on macOS, the original folder checked afterwards).
//
// Output, kept across sessions and never touched by the automatic capture:
//   <work>/manual/<key>/{full.png, full@1920.png, elements.json, meta.json}
// meta.json holds the purpose as typed (the report quotes it as is) and the element crops,
// crop-<n>.png, chosen in the game or later in the WebUI.

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { HttpError, openSse, readJson, sendFile } from "./http.js";
import { chooseSdk, findSdks } from "./sdk.js";
import { defaultSaveDir, listSaves, readSaveDirectory, stageSaves } from "./saves.js";
import { CaptureRun, cloneGame, fingerprint, readJsonFile, runs, sandboxProfile } from "./capture.js";
import { writeCrops } from "./crops.js";

const KEY_RE = /^shot-[0-9-]+$/;

/** Every shot of a game, oldest first. */
export function listShots(workDir) {
    const dir = path.join(workDir, "manual");
    let names;
    try {
        names = fs.readdirSync(dir);
    } catch {
        return [];
    }
    const shots = [];
    for (const name of names) {
        if (!KEY_RE.test(name)) continue;
        const meta = readJsonFile(path.join(dir, name, "meta.json"));
        if (meta) shots.push(meta);
    }
    return shots.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
}

function shotDir(workDir, key) {
    if (!KEY_RE.test(key)) throw new HttpError(400, "截图编号无效", "bad_key");
    return path.join(workDir, "manual", key);
}

/** The SDK's CJK font, so the annotation box shows Chinese in games that ship none. */
function sdkFont(sdk) {
    const p = path.join(sdk.path, "sdk-fonts", "SourceHanSansLite.ttf");
    return fs.existsSync(p) ? p : null;
}

let ManualRun = null;

function manualRunClass() {
    if (ManualRun) return ManualRun;
    ManualRun = class extends CaptureRun {
        constructor(opts) {
            super(opts);
            this.mode = "manual";
            this.useSaves = opts.useSaves;
            this.saveSource = opts.saveSource;
            this.saveDirectory = opts.saveDirectory;
            // The player sets the pace: no idle limit, and a session may last an afternoon.
            this.idleTimeoutMs = null;
            this.totalTimeoutMs = 8 * 60 * 60 * 1000;
            this.shots = [];
        }

        snapshot() {
            return { status: this.status, mode: "manual", sdk: this.sdk, sandbox: this.sandbox, shots: this.shots };
        }

        async start() {
            const workDir = this.game.workDir;
            const runDir = path.join(workDir, "manual-run");
            const outDir = path.join(workDir, "manual");
            const savesRoot = path.join(workDir, "manual-saves");
            this.emit("phase", { phase: "prepare" });
            await fsp.mkdir(outDir, { recursive: true });
            await fsp.mkdir(savesRoot, { recursive: true });

            const before = fingerprint(path.join(this.game.path, "game"));
            cloneGame(this.game.path, runDir);
            const font = sdkFont(this.sdk);
            if (font) fs.copyFileSync(font, path.join(runDir, "game", "_r2l_font.ttf"));

            // The player's own progress, copied in; saves made in this session stay in the work dir.
            let staged = null;
            if (this.useSaves && this.saveSource && this.saveDirectory) {
                const files = listSaves(this.saveSource).map((s) => s.file);
                staged = stageSaves({ sourceDir: this.saveSource, files, savesRoot, saveDirectory: this.saveDirectory, clean: false });
                this.emit("log", { message: "saves-staged", files: files.length, verifyingKeys: staged.verifyingKeys });
            }

            const jobFile = path.join(workDir, "manual-job.json");
            fs.writeFileSync(jobFile, JSON.stringify({ manual: true, out: outDir, unlock: this.unlock }, null, 2));
            const progressFile = path.join(outDir, "progress.jsonl");
            try {
                this.progressOffset = fs.statSync(progressFile).size;
            } catch {
                this.progressOffset = 0;
            }

            const env = { ...process.env, R2L_JOB: jobFile, RENPY_PATH_TO_SAVES: savesRoot };
            let cmd = this.sdk.launcher;
            let args = [runDir];
            if (this.sandbox) {
                const profile = path.join(workDir, "manual-sandbox.sb");
                fs.writeFileSync(profile, sandboxProfile(workDir));
                args = ["-f", profile, this.sdk.launcher, runDir];
                cmd = "/usr/bin/sandbox-exec";
            }

            this.emit("phase", { phase: "run" });
            const exit = await this.spawnAndFollow(cmd, args, env, progressFile);
            const after = fingerprint(path.join(this.game.path, "game"));
            let traceback = null;
            try {
                traceback = fs.readFileSync(path.join(runDir, "traceback.txt"), "utf8");
            } catch {
                // No traceback: the game closed normally.
            }
            this.status = this.cancelled ? "cancelled" : "done";
            const session = {
                endedAt: new Date().toISOString(),
                sdk: { path: this.sdk.path, version: this.sdk.version },
                sandbox: this.sandbox,
                exit,
                originalUnchanged: before.hash === after.hash,
                shots: this.shots.length,
                traceback,
            };
            fs.writeFileSync(path.join(outDir, "last-session.json"), JSON.stringify(session, null, 2));
            this.emit("end", { status: this.status, session });
            return session;
        }

        onProgress(ev) {
            if (ev.type === "shot") {
                this.shots.push(ev.key);
                this.emit("shot", { key: ev.key, purpose: ev.purpose, screens: ev.screens });
            }
        }
    };
    return ManualRun;
}

export function registerManual(router, { games }) {
    const saveDirectoryOf = (game) => {
        const inv = readJsonFile(path.join(game.workDir, "inventory.json"));
        return inv?.game?.saveDirectory || readSaveDirectory(game.path);
    };

    router.get("/api/games/:id/manual", ({ params }) => {
        const game = games.get(params.id);
        const run = runs.get(game.id);
        const saveDirectory = saveDirectoryOf(game);
        const saveSource = game.meta?.captureSaveDir || defaultSaveDir(saveDirectory);
        return {
            shots: listShots(game.workDir),
            running: run && run.status === "running" && run.mode === "manual" ? run.snapshot() : null,
            busy: Boolean(run && run.status === "running" && run.mode !== "manual"),
            saveSource,
            saveCount: saveSource ? listSaves(saveSource).length : 0,
            lastSession: readJsonFile(path.join(game.workDir, "manual", "last-session.json")),
        };
    });

    router.post("/api/games/:id/manual/start", async ({ req, params }) => {
        const body = await readJson(req);
        const game = games.get(params.id);
        if (!game.meta?.captureTrusted) throw new HttpError(409, "运行前需要确认信任该游戏", "needs_trust");
        if (!game.present) throw new HttpError(409, "游戏目录不存在", "game_missing");
        const existing = runs.get(game.id);
        if (existing && existing.status === "running") throw new HttpError(409, "游戏已在运行", "already_running");

        const inv = readJsonFile(path.join(game.workDir, "inventory.json"));
        const wantMajor = inv?.source?.sdkRecommendation?.major ?? null;
        const sdks = findSdks({ extra: body.sdk ? [body.sdk] : [] });
        const sdk = chooseSdk(sdks, { requested: body.sdk, wantMajor });
        if (!sdk) throw new HttpError(409, "未找到 Ren'Py SDK", "no_sdk");
        games.updateMeta(game.id, { captureSdk: sdk.path, sdk: sdk.version });

        const saveDirectory = saveDirectoryOf(game);
        const Run = manualRunClass();
        const run = new Run({
            game,
            sdk,
            sandbox: body.sandbox !== false,
            unlock: Boolean(body.unlock),
            useSaves: body.useSaves !== false,
            saveSource: game.meta?.captureSaveDir || defaultSaveDir(saveDirectory),
            saveDirectory,
        });
        runs.set(game.id, run);
        run.start().catch((err) => {
            run.status = "failed";
            run.emit("end", { status: "failed", error: err.message });
        });
        return { started: true, sdk };
    });

    router.post("/api/games/:id/manual/stop", async ({ req, params }) => {
        await readJson(req);
        const run = runs.get(params.id);
        if (run && run.status === "running" && run.mode === "manual") run.cancel();
    });

    router.get("/api/games/:id/manual/events", ({ req, res, params }) => {
        games.get(params.id);
        const sse = openSse(req, res);
        const run = runs.get(params.id);
        if (!run || run.mode !== "manual") {
            sse.send("idle", {});
            return;
        }
        for (const ev of run.events) sse.send(ev.type, ev);
        if (run.status !== "running") return;
        const listener = (ev) => sse.send(ev.type, ev);
        run.listeners.add(listener);
        sse.onClose(() => run.listeners.delete(listener));
    });

    router.get("/api/games/:id/manual/shots/:key", ({ params }) => {
        const game = games.get(params.id);
        const dir = shotDir(game.workDir, params.key);
        const meta = readJsonFile(path.join(dir, "meta.json"));
        if (!meta) throw new HttpError(404, "截图不存在", "no_shot");
        return { meta, elements: readJsonFile(path.join(dir, "elements.json")) };
    });

    router.put("/api/games/:id/manual/shots/:key", async ({ req, params }) => {
        const body = await readJson(req);
        const game = games.get(params.id);
        const file = path.join(shotDir(game.workDir, params.key), "meta.json");
        const meta = readJsonFile(file);
        if (!meta) throw new HttpError(404, "截图不存在", "no_shot");
        if (typeof body.purpose === "string") meta.purpose = body.purpose;
        meta.editedAt = Date.now() / 1000;
        fs.writeFileSync(file, JSON.stringify(meta, null, 1));
        return { meta };
    });

    router.put("/api/games/:id/manual/shots/:key/crops", async ({ req, params }) => {
        const body = await readJson(req, 64 * 1024 * 1024);
        const game = games.get(params.id);
        const dir = shotDir(game.workDir, params.key);
        const file = path.join(dir, "meta.json");
        const meta = readJsonFile(file);
        if (!meta) throw new HttpError(404, "截图不存在", "no_shot");
        meta.crops = writeCrops(dir, body.crops);
        meta.editedAt = Date.now() / 1000;
        fs.writeFileSync(file, JSON.stringify(meta, null, 1));
        return { meta };
    });

    router.delete("/api/games/:id/manual/shots/:key", ({ params }) => {
        const game = games.get(params.id);
        fs.rmSync(shotDir(game.workDir, params.key), { recursive: true, force: true });
    });

    router.get("/api/games/:id/manual/file/:key/:name", ({ req, res, params }) => {
        const game = games.get(params.id);
        if (!/^(full|full@1920|crop-\d+)\.png$/.test(params.name)) throw new HttpError(400, "文件名无效", "bad_name");
        sendFile(req, res, path.join(shotDir(game.workDir, params.key), params.name));
    });
}
