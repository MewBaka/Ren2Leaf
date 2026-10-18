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
// What runs the game is here (clone, sandbox profile, SDK choice, saves, progress following);
// what the session is for is in manual.js, which drives the player's own F9 captures.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { HttpError, readJson } from "./http.js";
import { execFile } from "node:child_process";
import { addSdkPath, chooseSdk, describeSdk, findSdks } from "./sdk.js";
import { defaultSaveDir, listSaves, readSaveDirectory } from "./saves.js";
import { registerManual } from "./manual.js";

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

export function readJsonFile(file, fallback = null) {
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
/**
 * Runs a game under a Ren'Py SDK and follows the progress file its injected script writes.
 * Subclasses say what the run is for; the only one is the manual capture session in manual.js.
 */
export class CaptureRun {
    constructor({ game, sdk, sandbox, unlock }) {
        this.game = game;
        this.sdk = sdk;
        this.sandbox = sandbox && process.platform === "darwin";
        this.unlock = unlock !== false;
        this.events = [];
        this.listeners = new Set();
        this.status = "running";
        this.child = null;
        this.cancelled = false;
    }

    emit(type, data = {}) {
        const event = { type, at: Date.now(), ...data };
        this.events.push(event);
        for (const fn of this.listeners) fn(event);
    }

    snapshot() {
        return { status: this.status, sdk: this.sdk, sandbox: this.sandbox };
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

            // A progress file that outlives one run (manual shots) is read from where it ended.
            let offset = this.progressOffset || 0;
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
                const total = this.totalTimeoutMs ?? TOTAL_TIMEOUT_MS;
                const idle = this.idleTimeoutMs === undefined ? IDLE_TIMEOUT_MS : this.idleTimeoutMs;
                if (now - started > total || (idle !== null && now - lastProgress > idle)) {
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

    cancel() {
        this.cancelled = true;
        if (this.child) this.child.kill("SIGKILL");
    }
}

export const runs = new Map();

export function pickFolder(prompt, startDir) {
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

export function register(router, ctx) {
    const { games } = ctx;
    registerManual(router, ctx);
    router.get("/api/games/:id/capture", ({ params }) => {
        const game = games.get(params.id);
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
        };
    });

    router.post("/api/games/:id/capture/trust", async ({ req, params }) => {
        const body = await readJson(req);
        const game = games.updateMeta(params.id, { captureTrusted: Boolean(body.trusted) });
        return { trusted: Boolean(game.meta.captureTrusted) };
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
        const inventory = readJsonFile(path.join(game.workDir, "inventory.json"));
        return inventory?.game?.saveDirectory || readSaveDirectory(game.path);
    };

    router.post("/api/games/:id/capture/saves/pick", async ({ req, params }) => {
        await readJson(req);
        const game = games.get(params.id);
        const start = game.meta?.captureSaveDir || defaultSaveDir(saveDirectoryOf(game));
        const picked = await pickFolder("选择存档目录", start);
        if (!picked) return { cancelled: true };
        games.updateMeta(game.id, { captureSaveDir: picked });
        return { dir: picked, saves: listSaves(picked).length };
    });
}
