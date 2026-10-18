// The game list (~/.ren2leaf/games.json) and each game's work directory (~/.ren2leaf/work/<id>/).
// Nothing here writes into a game's own folder.

import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { HttpError, readJson } from "./http.js";

export function defaultHome() {
    return process.env.REN2LEAF_HOME || path.join(os.homedir(), ".ren2leaf");
}

function isDir(p) {
    try {
        return fs.statSync(p).isDirectory();
    } catch {
        return false;
    }
}

/**
 * Normalises what a person pastes: quotes from Finder's "Copy as Pathname", a leading `~`,
 * backslash-escaped spaces from a terminal, and a trailing slash.
 */
export function cleanInputPath(input) {
    let p = String(input ?? "").trim();
    if ((p.startsWith("'") && p.endsWith("'")) || (p.startsWith("\"") && p.endsWith("\""))) {
        p = p.slice(1, -1);
    }
    if (p.startsWith("file://")) p = decodeURIComponent(new URL(p).pathname);
    p = p.replace(/\\([ ()'"&!])/g, "$1");
    if (p === "~" || p.startsWith("~/")) p = path.join(os.homedir(), p.slice(1));
    if (p.length > 1) p = p.replace(/\/+$/, "");
    return p;
}

/**
 * Finds the Ren'Py project root (the folder that holds `game/`) from what was picked.
 * Accepts the root itself, its `game/` folder, or a macOS `.app` bundle.
 */
export function resolveGameRoot(input) {
    const p = cleanInputPath(input);
    if (!p) throw new HttpError(400, "路径为空", "empty_path");
    if (!path.isAbsolute(p)) throw new HttpError(400, "需要绝对路径", "relative_path");
    if (!isDir(p)) throw new HttpError(400, "目录不存在", "not_found");
    const candidates = [p];
    if (path.basename(p) === "game") candidates.push(path.dirname(p));
    if (p.endsWith(".app")) candidates.push(path.join(p, "Contents", "Resources", "autorun"));
    for (const c of candidates) {
        if (isDir(path.join(c, "game"))) return fs.realpathSync(c);
    }
    throw new HttpError(400, "目录下没有 game 文件夹", "no_game_dir");
}

function readConfigName(root) {
    const gameDir = path.join(root, "game");
    let files;
    try {
        files = fs.readdirSync(gameDir).filter((f) => f.endsWith(".rpy"));
    } catch {
        return null;
    }
    files.sort((a, b) => (a === "options.rpy" ? -1 : b === "options.rpy" ? 1 : a.localeCompare(b)));
    const re = /^\s*define\s+config\.name\s*=\s*(?:_\(\s*)?(["'])((?:\\.|(?!\1).)*)\1/m;
    for (const f of files) {
        let text;
        try {
            text = fs.readFileSync(path.join(gameDir, f), "utf8");
        } catch {
            continue;
        }
        const m = re.exec(text);
        if (m && m[2].trim()) return m[2].replace(/\\(.)/g, "$1").trim();
    }
    return null;
}

/** A display name: `config.name` when the source is there, else the folder name without build suffixes. */
export function guessName(root) {
    const fromConfig = readConfigName(root);
    if (fromConfig) return fromConfig;
    let base = path.basename(root).replace(/\.app$/, "");
    for (;;) {
        const next = base.replace(/[-_ ](renpy|pc|mac|win|windows|linux|market|dists?)$/i, "");
        if (next === base || !next) break;
        base = next;
    }
    return base;
}

export function gameId(root) {
    return crypto.createHash("sha1").update(root).digest("hex").slice(0, 10);
}

export class GameStore {
    constructor(home = defaultHome()) {
        this.home = home;
        this.file = path.join(home, "games.json");
        // One generation back. The list has been found empty with the work directories still in
        // place and nobody having removed anything; until that is understood, a list that empties
        // itself is restored from here instead of costing somebody their games.
        this.backupFile = path.join(home, "games.backup.json");
    }

    readFile(file) {
        let data;
        try {
            data = JSON.parse(fs.readFileSync(file, "utf8"));
        } catch (err) {
            if (err.code === "ENOENT") return [];
            if (err instanceof SyntaxError) return [];
            throw err;
        }
        return Array.isArray(data?.games) ? data.games : [];
    }

    read() {
        const games = this.readFile(this.file);
        if (games.length) return games;
        // Removing the last game clears the backup, so a backup that still has entries here means
        // the list was lost, not emptied on purpose.
        const kept = this.readFile(this.backupFile).filter((g) => g && g.id && g.path);
        if (!kept.length) return games;
        console.warn(`games.json 是空的，从 ${path.basename(this.backupFile)} 恢复了 ${kept.length} 个游戏`);
        this.write(kept);
        return kept;
    }

    write(games, { forget = false } = {}) {
        fs.mkdirSync(this.home, { recursive: true });
        const body = JSON.stringify({ version: 1, games }, null, 2) + "\n";
        const tmp = `${this.file}.${process.pid}.${Date.now()}.tmp`;
        fs.writeFileSync(tmp, body);
        fs.renameSync(tmp, this.file);
        if (games.length) fs.writeFileSync(this.backupFile, body);
        else if (forget) fs.rmSync(this.backupFile, { force: true });
    }

    workDir(id) {
        if (!/^[0-9a-f]{10}$/.test(id)) throw new HttpError(400, "无效的游戏 id", "bad_id");
        return path.join(this.home, "work", id);
    }

    /** The record plus derived fields the UI and the steps need. */
    view(game) {
        return { ...game, workDir: this.workDir(game.id), present: isDir(path.join(game.path, "game")) };
    }

    list() {
        return this.read().map((g) => this.view(g));
    }

    get(id) {
        const game = this.read().find((g) => g.id === id);
        if (!game) throw new HttpError(404, "游戏不存在", "game_not_found");
        return this.view(game);
    }

    /** Adds a game, or returns the existing record when that folder is already listed. */
    add(input) {
        const root = resolveGameRoot(input);
        const id = gameId(root);
        const games = this.read();
        const existing = games.find((g) => g.id === id);
        if (existing) return { game: this.view(existing), added: false };
        const game = { id, name: guessName(root), path: root, addedAt: new Date().toISOString(), meta: {} };
        games.push(game);
        this.write(games);
        fs.mkdirSync(this.workDir(id), { recursive: true });
        return { game: this.view(game), added: true };
    }

    /** Removes the game from the list. Its work directory stays, so adding it again restores results. */
    remove(id) {
        const games = this.read();
        const next = games.filter((g) => g.id !== id);
        if (next.length === games.length) throw new HttpError(404, "游戏不存在", "game_not_found");
        // An explicit removal is the one way the list is allowed to end up empty.
        this.write(next, { forget: true });
    }

    /** Merges values into a game's `meta` (SDK version, resolution, last run). For the step modules. */
    updateMeta(id, patch) {
        const games = this.read();
        const game = games.find((g) => g.id === id);
        if (!game) throw new HttpError(404, "游戏不存在", "game_not_found");
        game.meta = { ...(game.meta || {}), ...patch };
        this.write(games);
        return this.view(game);
    }
}

function run(cmd, args) {
    return new Promise((resolve, reject) => {
        execFile(cmd, args, { timeout: 10 * 60 * 1000 }, (err, stdout, stderr) => {
            if (err) {
                err.stdout = stdout;
                err.stderr = stderr;
                reject(err);
            } else {
                resolve(stdout);
            }
        });
    });
}

/** Opens the native folder picker. Resolves to the chosen path, or null when cancelled. */
export async function pickFolder() {
    if (process.platform !== "darwin") {
        throw new HttpError(501, "当前系统不支持选择框，请粘贴路径", "picker_unsupported");
    }
    const script = [
        "activate",
        "POSIX path of (choose folder with prompt \"选择游戏目录\")",
    ].join("\n");
    try {
        const out = await run("osascript", ["-e", script]);
        return out.trim() || null;
    } catch (err) {
        if (/-128/.test(err.stderr || "")) return null;
        throw new HttpError(500, "无法打开选择框", "picker_failed");
    }
}

export async function revealInFinder(target) {
    if (process.platform !== "darwin") throw new HttpError(501, "当前系统不支持", "reveal_unsupported");
    await run("open", ["-R", target]);
}

export function registerGameRoutes(router, store) {
    router.get("/api/games", () => ({ games: store.list() }));

    router.get("/api/games/:id", ({ params }) => ({ game: store.get(params.id) }));

    router.post("/api/games", async ({ req }) => {
        const body = await readJson(req);
        return store.add(body.path);
    });

    router.post("/api/games/pick", async ({ req }) => {
        await readJson(req);
        const picked = await pickFolder();
        if (!picked) return { cancelled: true };
        return { path: cleanInputPath(picked) };
    });

    router.delete("/api/games/:id", ({ params }) => {
        store.remove(params.id);
    });

    router.post("/api/games/:id/reveal", async ({ req, params }) => {
        const body = await readJson(req);
        const game = store.get(params.id);
        const target = body.target === "work" ? game.workDir : game.path;
        await fsp.mkdir(game.workDir, { recursive: true });
        await revealInFinder(target);
    });
}
