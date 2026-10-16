// Step 2: capture every screen of a game by running it with the Ren'Py SDK.
//
// This is the one step that executes the game's code, so:
// - it runs only after the migrator confirmed they trust this game (stored per game, revocable);
// - it runs a clone of `game/` in the work directory, never the original, and checks afterwards
//   that the original folder did not change;
// - saves and persistent data go to the work directory (RENPY_PATH_TO_SAVES);
// - on macOS it runs under sandbox-exec by default: no outbound network, writes only to the work
//   directory and the system temp folders.
//
// Output (read by the WebUI and later by the report for the agent):
//   <work>/capture/manifest.json
//   <work>/capture/screens/<key>/{full.png, full@1920.png, annotated.png, elements.json, elements/, hover/}
//   <work>/capture/errors/<key>.txt

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { HttpError, openSse, readJson, sendFile } from "./http.js";
import { execFile } from "node:child_process";
import { addSdkPath, chooseSdk, describeSdk, findSdks } from "./sdk.js";
import { defaultSaveDir, listSaves, readSaveDirectory, saveThumbnail, slotOf, stageSaves } from "./saves.js";

const here = path.dirname(fileURLToPath(import.meta.url));
export const CAPTURE_SCRIPT = path.join(here, "..", "capture", "_ren2leaf_capture.rpy");

const SKIP_DIRS = new Set(["saves", "cache"]);
const TOTAL_TIMEOUT_MS = 30 * 60 * 1000;
const IDLE_TIMEOUT_MS = 3 * 60 * 1000;

/**
 * A cheap fingerprint of a folder: every file's path, size and mtime. Enough to tell whether the run
 * wrote anything into the original game, without reading gigabytes of media.
 */
export function fingerprint(dir) {
    const hash = crypto.createHash("sha1");
    let files = 0;
    const walk = (d) => {
        let entries;
        try {
            entries = fs.readdirSync(d, { withFileTypes: true });
        } catch {
            return;
        }
        entries.sort((a, b) => (a.name < b.name ? -1 : 1));
        for (const e of entries) {
            const p = path.join(d, e.name);
            if (e.isDirectory()) {
                walk(p);
            } else if (e.isFile()) {
                const st = fs.statSync(p);
                hash.update(`${path.relative(dir, p)}\0${st.size}\0${st.mtimeMs}\n`);
                files++;
            }
        }
    };
    walk(dir);
    return { hash: hash.digest("hex"), files };
}

/**
 * Clones `<root>/game` into `<runDir>/game` without saves and caches. On APFS the copy is a
 * copy-on-write clone, so even a multi-gigabyte game costs no disk and little time.
 */
export function cloneGame(root, runDir) {
    fs.rmSync(runDir, { recursive: true, force: true });
    fs.mkdirSync(runDir, { recursive: true });
    const src = path.join(root, "game");
    fs.cpSync(src, path.join(runDir, "game"), {
        recursive: true,
        mode: fs.constants.COPYFILE_FICLONE,
        dereference: true,
        filter: (p) => {
            const rel = path.relative(src, p);
            return !rel || !SKIP_DIRS.has(rel.split(path.sep)[0]);
        },
    });
    for (const name of ["_ren2leaf_capture.rpy", "_ren2leaf_capture.rpyc"]) {
        fs.rmSync(path.join(runDir, "game", name), { force: true });
    }
    fs.copyFileSync(CAPTURE_SCRIPT, path.join(runDir, "game", "_ren2leaf_capture.rpy"));
}

export function sandboxProfile(workDir) {
    const real = fs.realpathSync(workDir);
    const q = (s) => JSON.stringify(s);
    return [
        "(version 1)",
        "(allow default)",
        "(deny network-outbound (remote ip))",
        "(deny file-write*)",
        `(allow file-write* (subpath ${q(real)}) (subpath "/private/var/folders") (subpath "/private/tmp") (subpath "/dev"))`,
        "",
    ].join("\n");
}

function readJsonFile(file, fallback = null) {
    try {
        return JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
        return fallback;
    }
}

/** What the diagnose step recommends, if it has run: the SDK major version. */
function recommendedMajor(workDir) {
    const inv = readJsonFile(path.join(workDir, "inventory.json"));
    const v = inv?.source?.sdkRecommendation?.major;
    return typeof v === "number" ? v : null;
}

/**
 * One capture run. Emits events to listeners and keeps them so a page that connects late (or
 * reloads) can replay the run so far.
 */
class CaptureRun {
    constructor({ game, sdk, sandbox, targets, saves, detail, unlock, scriptScreens, gameMenuScreen }) {
        this.game = game;
        this.sdk = sdk;
        this.sandbox = sandbox && process.platform === "darwin";
        // [{ key, screen, branch }]: capture only these nodes, without following links.
        this.targets = targets && targets.length ? targets : null;
        // { sourceDir, files, saveDirectory }: capture what each save shows after loading it.
        this.saves = saves || null;
        this.partial = Boolean(this.targets || this.saves);
        this.detail = Boolean(detail);
        this.unlock = unlock !== false;
        this.scriptScreens = scriptScreens || [];
        this.gameMenuScreen = gameMenuScreen || null;
        this.events = [];
        this.listeners = new Set();
        this.status = "running";
        this.items = {};
        this.child = null;
        this.cancelled = false;
    }

    emit(type, data = {}) {
        const event = { type, at: Date.now(), ...data };
        this.events.push(event);
        for (const fn of this.listeners) fn(event);
    }

    snapshot() {
        return {
            status: this.status,
            sdk: this.sdk,
            sandbox: this.sandbox,
            items: this.items,
            order: this.order || [],
            current: this.current || null,
        };
    }

    async start() {
        const workDir = this.game.workDir;
        const runDir = path.join(workDir, "capture-run");
        const nextDir = path.join(workDir, "capture-next");
        const outDir = path.join(workDir, "capture");
        const savesDir = path.join(workDir, "capture-saves");
        const startedAt = new Date().toISOString();

        this.emit("phase", { phase: "prepare" });
        await fsp.mkdir(workDir, { recursive: true });
        const before = fingerprint(path.join(this.game.path, "game"));
        cloneGame(this.game.path, runDir);
        fs.rmSync(nextDir, { recursive: true, force: true });
        fs.mkdirSync(nextDir, { recursive: true });
        fs.mkdirSync(savesDir, { recursive: true });

        const fixtures = readJsonFile(path.join(workDir, "capture-fixtures.json"), {});
        const jobFile = path.join(workDir, "capture-job.json");
        const job = {
            out: nextDir,
            fixtures,
            detail: this.detail,
            unlock: this.unlock,
            scriptScreens: this.scriptScreens,
            gameMenuScreen: this.gameMenuScreen,
        };
        let savesRoot = savesDir;
        if (this.saves) {
            savesRoot = path.join(workDir, "capture-saves-load");
            const staged = stageSaves({
                sourceDir: this.saves.sourceDir,
                files: this.saves.files,
                savesRoot,
                saveDirectory: this.saves.saveDirectory,
            });
            this.emit("log", { message: "saves-staged", verifyingKeys: staged.verifyingKeys });
            job.saves = this.saves.files.map((f) => ({ key: saveKey(f), slot: slotOf(f) }));
        } else if (this.targets) {
            job.targets = this.targets;
        }
        fs.writeFileSync(jobFile, JSON.stringify(job, null, 2));

        const env = { ...process.env, R2L_JOB: jobFile, RENPY_PATH_TO_SAVES: savesRoot };
        let cmd = this.sdk.launcher;
        let args = [runDir];
        if (this.sandbox) {
            const profile = path.join(workDir, "capture-sandbox.sb");
            fs.writeFileSync(profile, sandboxProfile(workDir));
            args = ["-f", profile, this.sdk.launcher, runDir];
            cmd = "/usr/bin/sandbox-exec";
        }

        this.emit("phase", { phase: "run" });
        const exit = await this.spawnAndFollow(cmd, args, env, path.join(nextDir, "progress.jsonl"));

        const after = fingerprint(path.join(this.game.path, "game"));
        const traceback = (() => {
            try {
                return fs.readFileSync(path.join(runDir, "traceback.txt"), "utf8");
            } catch {
                return null;
            }
        })();

        const manifest = {
            schemaVersion: 1,
            startedAt,
            finishedAt: new Date().toISOString(),
            sdk: { path: this.sdk.path, version: this.sdk.version },
            sandbox: this.sandbox,
            exit,
            cancelled: this.cancelled,
            originalUnchanged: before.hash === after.hash,
            gameSize: this.discover?.gameSize || null,
            renpyVersion: this.discover?.renpyVersion || null,
            stageBackground: null,
            discover: this.discover || null,
            order: this.order || [],
            items: (this.order || []).map((key) => {
                const it = this.items[key] || {};
                // Left in the queue when the run stopped or hit its node limit.
                const status = !it.status || it.status === "pending" || it.status === "running" ? "skipped" : it.status;
                return { key, ...it, status };
            }),
            reached: this.reached || null,
            options: { detail: this.detail, unlock: this.unlock },
            traceback,
        };
        this.status = this.cancelled ? "cancelled" : this.gotDone ? "done" : "failed";
        manifest.status = this.status;

        const previous = readJsonFile(path.join(outDir, "manifest.json"));
        if (this.partial && previous && this.order && this.order.length) {
            // A partial run replaces only the nodes it captured, and the page states found behind them.
            const rerun = new Set(this.order);
            const stale = previous.items.filter((it) => it.via === "state" && rerun.has(it.parent) && !rerun.has(it.key));
            for (const it of stale) fs.rmSync(path.join(outDir, "screens", it.key), { recursive: true, force: true });
            const staleKeys = new Set(stale.map((it) => it.key));
            mergePartial(outDir, nextDir, this.order);
            const byKey = new Map(manifest.items.map((it) => [it.key, it]));
            const merged = previous.items.filter((it) => !staleKeys.has(it.key)).map((it) => (byKey.has(it.key) ? { ...it, ...byKey.get(it.key) } : it));
            for (const it of manifest.items) if (!previous.items.some((p) => p.key === it.key)) merged.push(it);
            const result = {
                ...previous,
                finishedAt: manifest.finishedAt,
                sdk: manifest.sdk,
                originalUnchanged: previous.originalUnchanged !== false && manifest.originalUnchanged,
                items: merged,
                order: merged.map((it) => it.key),
                lastPartial: { startedAt, keys: this.order, status: this.status, exit, traceback },
            };
            fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(result, null, 2));
            fs.rmSync(nextDir, { recursive: true, force: true });
            this.emit("end", { status: this.status, manifest: summarize(result) });
            return result;
        }

        manifest.items.push(...unreachedItems(manifest, readJsonFile(path.join(workDir, "inventory.json"))));
        manifest.order = manifest.items.map((it) => it.key);

        // Captures from saves cannot be redone from the screen list, so a full run keeps them.
        if (previous && !this.partial) {
            for (const it of previous.items || []) {
                if (!it.key.startsWith("save--") || it.status !== "ok" || manifest.items.some((m) => m.key === it.key)) continue;
                const from = path.join(outDir, "screens", it.key);
                if (!fs.existsSync(from)) continue;
                fs.mkdirSync(path.join(nextDir, "screens"), { recursive: true });
                fs.renameSync(from, path.join(nextDir, "screens", it.key));
                manifest.items.push(it);
                manifest.order.push(it.key);
            }
        }

        fs.writeFileSync(path.join(nextDir, "manifest.json"), JSON.stringify(manifest, null, 2));
        // Keep the previous results unless this run produced something.
        if (this.order && this.order.length) {
            fs.rmSync(outDir, { recursive: true, force: true });
            fs.renameSync(nextDir, outDir);
        }
        this.emit("end", { status: this.status, manifest: summarize(manifest) });
        return manifest;
    }

    spawnAndFollow(cmd, args, env, progressFile) {
        return new Promise((resolve) => {
            const child = spawn(cmd, args, { env, stdio: ["ignore", "pipe", "pipe"] });
            this.child = child;
            let log = "";
            const keepLog = (b) => {
                log = (log + b.toString()).slice(-20000);
            };
            child.stdout.on("data", keepLog);
            child.stderr.on("data", keepLog);

            let offset = 0;
            let partial = "";
            let lastProgress = Date.now();
            const started = Date.now();

            const poll = () => {
                let fd;
                try {
                    fd = fs.openSync(progressFile, "r");
                } catch {
                    return;
                }
                try {
                    const size = fs.fstatSync(fd).size;
                    if (size <= offset) return;
                    const buf = Buffer.alloc(size - offset);
                    fs.readSync(fd, buf, 0, buf.length, offset);
                    offset = size;
                    partial += buf.toString("utf8");
                    const lines = partial.split("\n");
                    partial = lines.pop();
                    for (const line of lines) {
                        if (!line.trim()) continue;
                        try {
                            this.onProgress(JSON.parse(line));
                            lastProgress = Date.now();
                        } catch {
                            // A half-written line is finished on the next poll.
                        }
                    }
                } finally {
                    fs.closeSync(fd);
                }
            };

            const timer = setInterval(() => {
                poll();
                const now = Date.now();
                if (now - started > TOTAL_TIMEOUT_MS || now - lastProgress > IDLE_TIMEOUT_MS) {
                    this.emit("log", { message: "timeout" });
                    child.kill("SIGKILL");
                }
            }, 300);

            child.on("exit", (code, signal) => {
                clearInterval(timer);
                poll();
                this.child = null;
                resolve({ code, signal, log: log.slice(-4000) });
            });
            child.on("error", (err) => {
                clearInterval(timer);
                this.child = null;
                resolve({ code: null, signal: null, error: err.message, log });
            });
        });
    }

    onProgress(ev) {
        if (ev.type === "start") {
            this.discover = ev.discover;
            this.order = [];
            this.emit("start", { order: this.order, gameSize: ev.discover?.gameSize, renpyVersion: ev.discover?.renpyVersion });
        } else if (ev.type === "item-add") {
            const { type, t, key, ...meta } = ev;
            if (!this.items[key]) this.order.push(key);
            this.items[key] = { ...meta, ...(this.items[key] || {}), status: this.items[key]?.status || "pending" };
            this.emit("item", { key, ...this.items[key] });
        } else if (ev.type === "item-start") {
            if (!this.items[ev.key]) this.order.push(ev.key);
            this.items[ev.key] = { ...(this.items[ev.key] || {}), status: "running" };
            this.current = ev.key;
            this.emit("item", { key: ev.key, ...this.items[ev.key] });
        } else if (ev.type === "item-done") {
            const { type, t, key, ...rest } = ev;
            if (!this.items[key]) this.order.push(key);
            this.items[key] = { ...(this.items[key] || {}), ...rest };
            this.emit("item", { key, ...this.items[key] });
        } else if (ev.type === "done") {
            this.current = null;
            this.gotDone = true;
            this.reached = ev.reached || null;
        }
    }

    cancel() {
        this.cancelled = true;
        if (this.child) this.child.kill("SIGKILL");
    }
}

export function saveKey(file) {
    return `save--${slotOf(file)}`;
}

/**
 * Screens the game defines but the run never reached: no button or key on a reachable screen opens
 * them, and the story does not show them. Screens included into a reached one with `use` are parts
 * of it, not separate pages. They are listed, not captured, so the migrator can decide.
 */
export function unreachedItems(manifest, inventory) {
    const defined = new Set((manifest.discover?.screens || []).map((s) => s.name).filter((n) => !n.startsWith("_")));
    if (!defined.size) return [];
    const reached = new Set();
    for (const it of manifest.items) {
        if (it.screen) reached.add(it.screen);
        if (it.key.startsWith("say--")) reached.add("say").add("quick_menu");
        if (it.key.startsWith("nvl--")) reached.add("nvl").add("nvl_dialogue");
        if (it.key.startsWith("choice--")) reached.add("choice");
    }
    for (const n of manifest.reached || []) reached.add(n);
    // Close over `use`: a reached screen's parts are reached too.
    const uses = new Map((inventory?.screens || []).map((s) => [s.name, s.uses || []]));
    const stack = [...reached];
    while (stack.length) {
        const name = stack.pop();
        for (const u of uses.get(name) || []) {
            const target = typeof u === "string" ? u : u.name || u.screen;
            if (target && !reached.has(target)) {
                reached.add(target);
                stack.push(target);
            }
        }
    }
    return [...defined]
        .filter((n) => !reached.has(n))
        .sort()
        .map((n) => ({ key: n, screen: n, status: "unreached" }));
}

/** Screens the story shows or calls from a label, from the diagnose inventory. */
export function scriptScreens(inventory) {
    const out = [];
    for (const s of inventory?.screens || []) {
        if (!s.defined) continue;
        if ((s.callSites || []).some((c) => c.label && c.kind !== "menu" && c.kind !== "use")) out.push(s.name);
    }
    return out;
}

function mergePartial(outDir, nextDir, keys) {
    for (const key of keys) {
        for (const sub of ["screens", "errors"]) {
            const name = sub === "errors" ? `${key}.txt` : key;
            const from = path.join(nextDir, sub, name);
            const to = path.join(outDir, sub, name);
            fs.rmSync(to, { recursive: true, force: true });
            if (fs.existsSync(from)) {
                fs.mkdirSync(path.dirname(to), { recursive: true });
                fs.renameSync(from, to);
            }
        }
    }
}

function summarize(manifest) {
    if (!manifest) return null;
    const counts = {};
    for (const it of manifest.items || []) counts[it.status] = (counts[it.status] || 0) + 1;
    return {
        status: manifest.status,
        startedAt: manifest.startedAt,
        finishedAt: manifest.finishedAt,
        sdk: manifest.sdk,
        sandbox: manifest.sandbox,
        originalUnchanged: manifest.originalUnchanged,
        gameSize: manifest.gameSize,
        renpyVersion: manifest.renpyVersion,
        counts,
        items: manifest.items,
        hasTraceback: Boolean(manifest.traceback),
        splashSkipped: manifest.discover?.splashSkipped || [],
        options: manifest.options || null,
        discover: manifest.discover ? { characters: manifest.discover.characters, gameSize: manifest.discover.gameSize } : null,
    };
}

const runs = new Map();

function pickFolder(prompt, startDir) {
    if (process.platform !== "darwin") {
        return Promise.reject(new HttpError(501, "当前系统不支持选择框", "picker_unsupported"));
    }
    const q = (v) => JSON.stringify(String(v));
    const where = startDir && fs.existsSync(startDir) ? ` default location (POSIX file ${q(startDir)})` : "";
    const script = `activate\nPOSIX path of (choose folder with prompt ${q(prompt)}${where})`;
    return new Promise((resolve, reject) => {
        execFile("osascript", ["-e", script], { timeout: 10 * 60 * 1000 }, (err, stdout, stderr) => {
            if (err) {
                if (/-128/.test(stderr || "")) resolve(null);
                else reject(new HttpError(500, "无法打开选择框", "picker_failed"));
                return;
            }
            resolve(stdout.trim().replace(/\/+$/, "") || null);
        });
    });
}

/** Resolves a path under the capture output folder, refusing anything that escapes it. */
function captureFile(workDir, rel) {
    const base = path.join(workDir, "capture");
    const file = path.resolve(base, rel);
    if (!file.startsWith(base + path.sep)) throw new HttpError(400, "路径无效", "bad_path");
    return file;
}

export function register(router, { games }) {
    router.get("/api/games/:id/capture", ({ params }) => {
        const game = games.get(params.id);
        const manifest = readJsonFile(path.join(game.workDir, "capture", "manifest.json"));
        const run = runs.get(game.id);
        const sdks = findSdks();
        const recommended = recommendedMajor(game.workDir);
        return {
            trusted: Boolean(game.meta?.captureTrusted),
            sandboxAvailable: process.platform === "darwin",
            sdks,
            recommendedMajor: recommended,
            defaultSdk: chooseSdk(sdks, { requested: game.meta?.captureSdk, wantMajor: recommended })?.path || null,
            run: run && run.status === "running" ? run.snapshot() : null,
            result: summarize(manifest),
        };
    });

    router.post("/api/games/:id/capture/trust", async ({ req, params }) => {
        const body = await readJson(req);
        const game = games.updateMeta(params.id, { captureTrusted: Boolean(body.trusted) });
        return { trusted: Boolean(game.meta.captureTrusted) };
    });

    router.post("/api/games/:id/capture/run", async ({ req, params }) => {
        const body = await readJson(req);
        const game = games.get(params.id);
        if (!game.meta?.captureTrusted) throw new HttpError(409, "运行前需要确认信任该游戏", "needs_trust");
        if (!game.present) throw new HttpError(409, "游戏目录不存在", "game_missing");
        const existing = runs.get(game.id);
        if (existing && existing.status === "running") throw new HttpError(409, "截图正在进行", "already_running");

        const sdks = findSdks({ extra: body.sdk ? [body.sdk] : [] });
        const sdk = chooseSdk(sdks, { requested: body.sdk, wantMajor: recommendedMajor(game.workDir) });
        if (!sdk) throw new HttpError(409, "未找到 Ren'Py SDK", "no_sdk");
        games.updateMeta(game.id, { captureSdk: sdk.path, sdk: sdk.version });

        let saves = null;
        if (Array.isArray(body.saves) && body.saves.length) {
            const dir = game.meta?.captureSaveDir || defaultSaveDir(saveDirectoryOf(game));
            const saveDirectory = saveDirectoryOf(game);
            if (!dir) throw new HttpError(409, "未选择存档目录", "no_save_dir");
            if (!saveDirectory) throw new HttpError(409, "无法确定该游戏的存档目录名", "no_save_directory");
            const known = new Set(listSaves(dir).map((s) => s.file));
            const files = body.saves.filter((f) => known.has(f));
            if (!files.length) throw new HttpError(400, "所选存档不存在", "no_saves");
            saves = { sourceDir: dir, files, saveDirectory };
        }

        // The story's own screens come from the static scan; run it first when it has not run yet.
        let inventory = readJsonFile(path.join(game.workDir, "inventory.json"));
        if (!inventory) {
            const { diagnose } = await import("./diagnose/index.js");
            inventory = await diagnose(game.path);
            await fsp.mkdir(game.workDir, { recursive: true });
            fs.writeFileSync(path.join(game.workDir, "inventory.json"), JSON.stringify(inventory, null, 2));
        }

        // A partial run names keys from the last result; a page state is redone through its screen.
        let targets = null;
        if (Array.isArray(body.targets) && body.targets.length) {
            const previous = readJsonFile(path.join(game.workDir, "capture", "manifest.json"));
            const byKey = new Map((previous?.items || []).map((it) => [it.key, it]));
            const seen = new Set();
            targets = [];
            for (const key of body.targets) {
                let it = byKey.get(key) || { key, screen: key };
                if (it.via === "state" && it.parent) it = byKey.get(it.parent) || { key: it.parent, screen: it.screen };
                if (seen.has(it.key)) continue;
                seen.add(it.key);
                targets.push({ key: it.key, screen: it.screen || null, branch: it.branch || null });
            }
        }

        const run = new CaptureRun({
            game,
            sdk,
            sandbox: body.sandbox !== false,
            targets,
            saves,
            detail: Boolean(body.detail),
            unlock: body.unlock !== false,
            scriptScreens: scriptScreens(inventory),
            gameMenuScreen: (inventory.screens || []).find((sc) => (sc.callSites || []).some((c) => c.via === "_game_menu_screen"))?.name || null,
        });
        runs.set(game.id, run);
        run.start()
            .then((manifest) => {
                games.updateMeta(game.id, {
                    ...(manifest.gameSize ? { resolution: manifest.gameSize.join("×") } : {}),
                    lastRunAt: manifest.finishedAt,
                });
            })
            .catch((err) => {
                run.status = "failed";
                run.emit("end", { status: "failed", error: err.message });
            });
        return { started: true, sdk };
    });

    router.post("/api/games/:id/capture/cancel", async ({ req, params }) => {
        await readJson(req);
        const run = runs.get(params.id);
        if (run && run.status === "running") run.cancel();
    });

    router.get("/api/games/:id/capture/events", ({ req, res, params }) => {
        games.get(params.id);
        const sse = openSse(req, res);
        const run = runs.get(params.id);
        if (!run) {
            sse.send("idle", {});
            return;
        }
        for (const ev of run.events) sse.send(ev.type, ev);
        if (run.status !== "running") return;
        const listener = (ev) => sse.send(ev.type, ev);
        run.listeners.add(listener);
        sse.onClose(() => run.listeners.delete(listener));
    });

    router.get("/api/games/:id/capture/manifest", ({ params }) => {
        const game = games.get(params.id);
        const manifest = readJsonFile(path.join(game.workDir, "capture", "manifest.json"));
        if (!manifest) throw new HttpError(404, "尚未截图", "no_capture");
        return manifest;
    });

    router.get("/api/games/:id/capture/screens/:key", ({ params }) => {
        const game = games.get(params.id);
        const data = readJsonFile(captureFile(game.workDir, path.join("screens", params.key, "elements.json")));
        if (!data) throw new HttpError(404, "该界面没有截图", "no_screen");
        return data;
    });

    router.get("/api/games/:id/capture/file/:rel", ({ req, res, params }) => {
        const game = games.get(params.id);
        sendFile(req, res, captureFile(game.workDir, params.rel));
    });

    router.post("/api/capture/sdk/pick", async ({ req }) => {
        await readJson(req);
        const picked = await pickFolder("选择 Ren'Py SDK 目录");
        if (!picked) return { cancelled: true };
        const sdk = describeSdk(picked);
        if (!sdk) throw new HttpError(400, "该目录不是 Ren'Py SDK", "not_sdk");
        addSdkPath(sdk.path);
        return { sdk };
    });

    const saveDirectoryOf = (game) => {
        const manifest = readJsonFile(path.join(game.workDir, "capture", "manifest.json"));
        return manifest?.discover?.saveDirectory || readSaveDirectory(game.path);
    };

    const savesView = (game, dir) => ({
        dir,
        saveDirectory: saveDirectoryOf(game),
        saves: dir ? listSaves(dir) : [],
    });

    router.get("/api/games/:id/capture/saves", ({ params }) => {
        const game = games.get(params.id);
        const dir = game.meta?.captureSaveDir || defaultSaveDir(saveDirectoryOf(game));
        return savesView(game, dir);
    });

    router.post("/api/games/:id/capture/saves/pick", async ({ req, params }) => {
        await readJson(req);
        const game = games.get(params.id);
        const start = game.meta?.captureSaveDir || defaultSaveDir(saveDirectoryOf(game));
        const picked = await pickFolder("选择存档目录", start);
        if (!picked) return { cancelled: true };
        games.updateMeta(game.id, { captureSaveDir: picked });
        return savesView(game, picked);
    });

    router.get("/api/games/:id/capture/saves/thumb/:file", ({ res, params }) => {
        const game = games.get(params.id);
        const dir = game.meta?.captureSaveDir || defaultSaveDir(saveDirectoryOf(game));
        if (!dir) throw new HttpError(404, "没有存档目录", "no_save_dir");
        let png;
        try {
            png = saveThumbnail(dir, params.file);
        } catch {
            throw new HttpError(404, "存档不存在", "no_save");
        }
        if (!png) throw new HttpError(404, "存档没有缩略图", "no_thumb");
        res.writeHead(200, { "Content-Type": "image/png", "Content-Length": png.length, "Cache-Control": "no-cache" });
        res.end(png);
    });

    router.get("/api/games/:id/capture/fixtures", ({ params }) => {
        const game = games.get(params.id);
        return readJsonFile(path.join(game.workDir, "capture-fixtures.json"), {});
    });

    router.put("/api/games/:id/capture/fixtures", async ({ req, params }) => {
        const body = await readJson(req);
        const game = games.get(params.id);
        if (typeof body !== "object" || Array.isArray(body)) throw new HttpError(400, "格式无效", "bad_fixtures");
        await fsp.mkdir(game.workDir, { recursive: true });
        fs.writeFileSync(path.join(game.workDir, "capture-fixtures.json"), JSON.stringify(body, null, 2));
        return body;
    });
}
