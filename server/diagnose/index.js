// Step ① diagnose: a static, read-only scan of a Ren'Py game. It never runs game code; .rpy and
// .py files are only read as text. The result (inventory.json) feeds step ② capture and the
// final report, so its shape is versioned by SCHEMA_VERSION and only grows by new fields.
//
// All paths in the inventory are relative to the game/ folder, with "/" separators.

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { Collector, scanFile } from "./scan.js";
import { buildScreens, byLocation } from "./screens.js";
import { buildSpeakers } from "./speakers.js";
import { buildPython } from "./python.js";
import { buildFlow } from "./flow.js";
import { buildFacts } from "./facts.js";

export const SCHEMA_VERSION = 2;
export const SCANNER_VERSION = "0.2.0";

const SKIP_DIRS = new Set(["cache", "saves", "__pycache__", "node_modules"]);
const HIT_LIMIT = 500;

function isDir(p) {
    try {
        return fs.statSync(p).isDirectory();
    } catch {
        return false;
    }
}

/** Accepts the project root (holding game/) or the game/ folder itself. */
export function resolveGameDirs(dir) {
    const abs = path.resolve(dir);
    if (isDir(path.join(abs, "game"))) return { root: abs, game: path.join(abs, "game") };
    if (path.basename(abs) === "game" && isDir(abs)) return { root: path.dirname(abs), game: abs };
    throw Object.assign(new Error(`没有找到 game 文件夹：${abs}`), { code: "no_game_dir" });
}

async function walk(base) {
    const out = [];
    const visit = async (dir) => {
        const entries = await fsp.readdir(dir, { withFileTypes: true });
        for (const d of entries) {
            if (d.name.startsWith(".")) continue;
            const full = path.join(dir, d.name);
            // Symlinks are not followed: the scan stays inside the game folder.
            if (d.isDirectory()) {
                if (!(dir === base && SKIP_DIRS.has(d.name)) && d.name !== "__pycache__") await visit(full);
            } else if (d.isFile()) out.push(path.relative(base, full).split(path.sep).join("/"));
        }
    };
    await visit(base);
    return out.sort();
}

async function readHead(file, bytes) {
    const fh = await fsp.open(file, "r");
    try {
        const buf = Buffer.alloc(bytes);
        const { bytesRead } = await fh.read(buf, 0, bytes, 0);
        return buf.subarray(0, bytesRead);
    } finally {
        await fh.close();
    }
}

async function readText(file) {
    try {
        return await fsp.readFile(file, "utf8");
    } catch {
        return null;
    }
}

const majorOf = (v) => (v ? Number(String(v).split(".")[0]) || null : null);

async function versionClues(root, game, files) {
    const clues = [];
    const rel = (p) => path.relative(game, p).split(path.sep).join("/");
    const add = (c) => clues.push({ strength: "strong", ...c });

    const sv = files.includes("script_version.txt") ? await readText(path.join(game, "script_version.txt")) : null;
    if (sv) {
        const nums = sv.match(/\d+/g);
        if (nums) add({ source: "scriptVersion", file: "script_version.txt", value: nums.join("."), suggestsMajor: Number(nums[0]), message: "启动器构建时写入的 Ren'Py 版本" });
    }

    const renpyDirs = [path.join(root, "renpy")];
    try {
        for (const d of await fsp.readdir(root)) {
            if (d.endsWith(".app")) renpyDirs.push(path.join(root, d, "Contents", "Resources", "autorun", "renpy"));
        }
    } catch {}
    for (const rd of renpyDirs) {
        const vc = await readText(path.join(rd, "vc_version.py"));
        const vm = vc && /\bversion\s*=\s*u?['"](\d+\.\d+[\d.]*)/.exec(vc);
        if (vm) add({ source: "engineFiles", file: rel(path.join(rd, "vc_version.py")), value: vm[1], suggestsMajor: majorOf(vm[1]), message: "随游戏发布的引擎版本" });
        const init = await readText(path.join(rd, "__init__.py"));
        const im = init && /version_tuple\s*=\s*\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/.exec(init);
        if (im) add({ source: "engineFiles", file: rel(path.join(rd, "__init__.py")), value: im.slice(1, 4).join("."), suggestsMajor: Number(im[1]), message: "随游戏发布的引擎版本" });
    }

    try {
        for (const d of await fsp.readdir(path.join(root, "lib"))) {
            const m = /^py([23])-|^python([23])\./.exec(d);
            if (m) add({ source: "pythonRuntime", file: rel(path.join(root, "lib", d)), value: d, suggestsMajor: (m[1] || m[2]) === "3" ? 8 : 7, message: "随游戏发布的 Python 运行库" });
        }
    } catch {}

    try {
        for (const f of (await fsp.readdir(path.join(game, "cache"))).sort()) {
            const m = /^bytecode(?:-(\d+))?\.rpyb$/.exec(f);
            if (!m) continue;
            const py = m[1] || "27";
            const v = { 27: "≤7", 39: "8.0–8.1", 311: "8.2–8.3", 312: "8.4+" }[py] || null;
            clues.push({ source: "bytecodeCache", strength: "weak", file: `cache/${f}`, value: v, suggestsMajor: py.startsWith("2") ? 7 : 8, message: "字节码缓存，可能是之后用别的 SDK 运行时留下的" });
        }
    } catch {}
    return clues;
}

function pickInfo(entries, col, ctxKind) {
    // Prefer definitions outside tl/; report conflicting or non-literal values.
    const sorted = [...entries].sort((a, b) => (a.file.startsWith("tl/") - b.file.startsWith("tl/")) || byLocation(a, b));
    const lits = sorted.filter((e) => e.ok);
    for (const e of sorted.filter((e) => !e.ok)) {
        col.review.push({ kind: "nonLiteralConfig", file: e.file, line: e.line, label: null, screen: null, snippet: e.snippet, message: `${ctxKind} 不是字面量，静态无法确定` });
    }
    const values = new Set(lits.map((e) => JSON.stringify(e.value)));
    if (values.size > 1) {
        for (const e of lits.slice(1)) col.review.push({ kind: "conflictingConfig", file: e.file, line: e.line, label: null, screen: null, snippet: e.snippet, message: `${ctxKind} 有多处不同的定义，取第一处` });
    }
    return lits[0] || null;
}

function gcd(a, b) {
    return b ? gcd(b, a % b) : a;
}

function gameInfo(col) {
    const at = (e) => (e ? { file: e.file, line: e.line } : null);
    const name = pickInfo(col.info.name, col, "config.name");
    const version = pickInfo(col.info.version, col, "config.version");
    const gi = pickInfo(col.info.guiInit, col, "gui.init");
    const sw = pickInfo(col.info.screenWidth, col, "config.screen_width");
    const sh = pickInfo(col.info.screenHeight, col, "config.screen_height");
    const save = pickInfo(col.info.saveDirectory, col, "config.save_directory");
    let resolution = null;
    if (gi) resolution = { width: gi.value[0], height: gi.value[1], source: "gui.init", ...at(gi) };
    else if (sw && sh && typeof sw.value === "number" && typeof sh.value === "number") resolution = { width: sw.value, height: sh.value, source: "config.screen_width", ...at(sw) };
    if (resolution) {
        const g = gcd(resolution.width, resolution.height) || 1;
        resolution.aspectRatio = `${resolution.width / g}:${resolution.height / g}`;
        resolution.is16x9 = resolution.width * 9 === resolution.height * 16;
    } else {
        col.review.push({ kind: "resolutionNotFound", file: null, line: null, label: null, screen: null, snippet: null, message: "没有找到 gui.init 或 config.screen_width/height 的字面量" });
    }
    return {
        name: name ? name.value : null,
        nameAt: at(name),
        version: version ? version.value : null,
        versionAt: at(version),
        resolution,
        saveDirectory: save ? save.value : null,
    };
}

function recommend(engineVersion, py2Syntax, py2Api, py3, clues) {
    const reasons = [];
    let major;
    let confidence;
    if (engineVersion) {
        major = engineVersion.major >= 8 ? 8 : 7;
        confidence = "high";
        reasons.push(`游戏由 Ren'Py ${engineVersion.version} 构建（${engineVersion.file}）`);
        if (major === 8 && py2Syntax) reasons.push(`但有 ${py2Syntax} 处 Python 2 语法特征，可能在未加载的文件里，需要核对`);
    } else if (py2Syntax) {
        major = 7;
        confidence = "high";
        reasons.push(`有 ${py2Syntax} 处 Python 2 语法，Ren'Py 8 无法编译`);
    } else if (py2Api) {
        major = 7;
        confidence = "medium";
        reasons.push(`有 ${py2Api} 处 Python 2 专有 API 调用`);
    } else {
        major = 8;
        const weak = clues.find((c) => c.strength === "weak" && c.suggestsMajor);
        confidence = py3.length ? "high" : "medium";
        if (py3.length) reasons.push(`有 ${py3.length} 处只有 Python 3 支持的写法`);
        else reasons.push("没有 Python 2 特征，默认用 8");
        if (weak) reasons.push(`字节码缓存提示 ${weak.value}（弱线索）`);
    }
    return { major, exactVersion: engineVersion ? engineVersion.version : null, confidence, reasons };
}

function resolveCharacterKinds(col) {
    const byVar = new Map();
    for (const c of col.characters) if (!byVar.has(c.variable)) byVar.set(c.variable, c);
    const resolve = (c, depth = 0) => {
        const k = c.kindSource;
        if (!k) return "adv";
        if (/^(adv|nvl|bubble)$/.test(k)) return k;
        const base = byVar.get(k);
        if (base && base !== c && depth < 10) return resolve(base, depth + 1);
        return null;
    };
    // Character(kind=e) without a name takes e's name, as Ren'Py does.
    const inheritName = (c, depth = 0) => {
        const base = byVar.get(c.kindSource);
        if (c.nameGiven || !base || base === c || depth >= 10) return;
        inheritName(base, depth + 1);
        c.displayName = base.displayName;
        c.nameExpression = base.nameExpression;
    };
    for (const c of col.characters) inheritName(c);
    for (const c of col.characters) {
        c.kind = resolve(c);
        if (c.kind === null) {
            col.review.push({ kind: "unresolvedCharacterKind", file: c.file, line: c.line, label: c.label, screen: null, snippet: `${c.variable} kind=${c.kindSource}`, message: `角色 ${c.variable} 的 kind=${c.kindSource} 无法静态解析` });
        }
    }
    return col.characters.sort(byLocation);
}

/**
 * Scans a Ren'Py game without running it.
 * @param {string} gameDir project root (the folder holding game/) or game/ itself
 * @returns {Promise<object>} the inventory (see SCHEMA_VERSION)
 */
export async function diagnose(gameDir) {
    const { root, game } = resolveGameDirs(gameDir);
    const files = await walk(game);
    const col = new Collector();

    const ext = (f) => path.extname(f).toLowerCase();
    const scripts = files.filter((f) => ext(f) === ".rpy" || ext(f) === ".rpym");
    const compiled = files.filter((f) => ext(f) === ".rpyc" || ext(f) === ".rpymc");
    const pyFiles = files.filter((f) => ext(f) === ".py");
    const archives = files.filter((f) => ext(f) === ".rpa");

    for (const f of scripts) {
        const text = await readText(path.join(game, f));
        if (text != null) scanFile(col, f, text);
    }
    for (const f of pyFiles) {
        const text = await readText(path.join(game, f));
        if (text != null) scanFile(col, f, text, { pythonFile: true });
    }

    const scriptSet = new Set(scripts);
    const compiledOnly = compiled.filter((f) => !scriptSet.has(f.slice(0, -1)));
    const archiveInfo = [];
    for (const f of archives) {
        const full = path.join(game, f);
        const head = (await readHead(full, 64)).toString("latin1");
        const fm = /^(RPA-\d\.\d|ALT-\d\.\d)/.exec(head);
        archiveInfo.push({ path: f, size: (await fsp.stat(full)).size, format: fm ? fm[1] : "unknown" });
    }
    for (const f of compiledOnly) col.review.push({ kind: "compiledOnlyFile", file: f, line: null, label: null, screen: null, snippet: null, message: "只有 .rpyc 没有源码，里面的界面和角色扫不到，需要先反编译" });
    for (const a of archiveInfo) col.review.push({ kind: "archive", file: a.path, line: null, label: null, screen: null, snippet: null, message: "有 .rpa 归档，里面可能有脚本，本工具不解包" });
    for (const e of col.lexErrors) col.review.push({ kind: "lexError", file: e.file, line: e.line, label: null, screen: null, snippet: null, message: e.message });

    let status;
    if (scripts.length) status = compiledOnly.length || archives.length ? "partialSource" : "source";
    else if (compiled.length) status = "compiledOnly";
    else if (archives.length) status = "archivedOnly";
    else status = "empty";

    const clues = await versionClues(root, game, files);
    for (const d of col.directives) clues.push({ source: "rpyDirective", strength: "weak", file: d.file, line: d.line, value: `rpy python ${d.value}`, suggestsMajor: null, message: "按 Python 3 语义编译的指令（7.x 用）" });
    if (col.screenDefs.some((d) => d.name === "bubble")) {
        const d = col.screenDefs.find((x) => x.name === "bubble");
        clues.push({ source: "template", strength: "weak", file: d.file, line: d.line, value: "screen bubble", suggestsMajor: 8, message: "对话气泡界面出自 8.1 以后的模板" });
    }
    const strong = clues.find((c) => c.strength === "strong" && c.source !== "pythonRuntime" && c.value);
    const runtime = clues.find((c) => c.source === "pythonRuntime");
    const engineVersion = strong ? { version: strong.value, major: strong.suggestsMajor, file: strong.file } : runtime ? { version: `${runtime.suggestsMajor}.x`, major: runtime.suggestsMajor, file: runtime.file } : null;

    const py2Syntax = col.py2.filter((h) => h.severity === "syntax");
    const py2Api = col.py2.filter((h) => h.severity === "api");
    const sdkRecommendation = recommend(engineVersion, py2Syntax.length, py2Api.length, col.py3, clues);

    const info = gameInfo(col);
    const menuScreen = pickInfo(col.info.gameMenuScreen, col, "_game_menu_screen");
    // ShowMenu() with no screen opens _game_menu_screen. Unset, the engine falls back to the save
    // screen, then preferences (renpy/common/00layout.rpy).
    let gameMenuScreen = null;
    if (menuScreen && typeof menuScreen.value === "string") gameMenuScreen = { screen: menuScreen.value, via: "_game_menu_screen" };
    else if (!menuScreen) {
        const fallback = ["save", "preferences"].find((n) => col.screenDefs.some((d) => d.name === n));
        if (fallback) gameMenuScreen = { screen: fallback, via: "_game_menu_screen 默认值" };
    }
    if (!gameMenuScreen) {
        for (const s of col.callSites.filter((x) => x.gameMenuDefault)) {
            col.review.push({ kind: "dynamicScreenName", file: s.file, line: s.line, label: s.label, screen: s.caller, snippet: `ShowMenu${s.args ?? "()"}`, message: "ShowMenu() 没写界面名，目标取 _game_menu_screen，没找到它的字面量定义" });
        }
    }

    const screens = buildScreens(col, gameMenuScreen);
    for (const s of screens) {
        if (!s.defined && s.category === "custom") {
            const c = s.callSites[0];
            col.review.push({ kind: "undefinedScreen", file: c?.file ?? null, line: c?.line ?? null, label: c?.label ?? null, screen: c?.caller ?? null, snippet: null, message: `界面 ${s.name} 被调用但源码里没有定义（可能在 .rpyc/.rpa 里）` });
        }
    }
    const characters = resolveCharacterKinds(col);

    const needsReview = col.review.sort((a, b) => (a.file ?? "").localeCompare(b.file ?? "") || (a.line ?? 0) - (b.line ?? 0));
    const cap = (list) => list.slice(0, HIT_LIMIT);
    const actionTotals = {};
    for (const s of screens) for (const [k, v] of Object.entries(s.actions)) actionTotals[k] = (actionTotals[k] || 0) + v;

    return {
        schemaVersion: SCHEMA_VERSION,
        scanner: { name: "ren2leaf-diagnose", version: SCANNER_VERSION },
        generatedAt: new Date().toISOString(),
        game: info,
        source: {
            status,
            files: { rpy: files.filter((f) => ext(f) === ".rpy").length, rpym: files.filter((f) => ext(f) === ".rpym").length, rpyc: compiled.length, py: pyFiles.length, rpa: archives.length },
            compiledOnly,
            archives: archiveInfo,
            engineVersion,
            versionClues: clues,
            python2: {
                syntaxHits: py2Syntax.length,
                apiHits: py2Api.length,
                hits: cap(col.py2.sort(byLocation)),
                truncated: col.py2.length > HIT_LIMIT,
            },
            python3Clues: cap(col.py3.sort(byLocation)),
            sdkRecommendation,
        },
        screens,
        characters,
        needsReview,
        summary: {
            screens: screens.filter((s) => s.defined).length,
            standardScreens: screens.filter((s) => s.defined && s.category === "standard").length,
            customScreens: screens.filter((s) => s.defined && s.category === "custom").length,
            undefinedScreens: screens.filter((s) => !s.defined).length,
            interactiveScreens: screens.filter((s) => s.classification === "interactive").length,
            dialogueLikeScreens: screens.filter((s) => s.classification === "dialogue_like").length,
            callSites: screens.reduce((n, s) => n + s.callSites.length, 0),
            characters: characters.length,
            needsReview: needsReview.length,
            actionKinds: Object.fromEntries(Object.entries(actionTotals).sort(([a], [b]) => a.localeCompare(b))),
        },
        // One key per later scan step. Each is built from the same pass over the sources.
        extensions: {
            speakers: buildSpeakers(col, characters),
            python: buildPython(col),
            flow: buildFlow(col),
            facts: buildFacts(col),
        },
    };
}

// ------------------------------------------------------------------ routes

function readInventory(workDir) {
    try {
        return JSON.parse(fs.readFileSync(path.join(workDir, "inventory.json"), "utf8"));
    } catch {
        return null;
    }
}

/** Routes for the WebUI. The scan writes <work>/inventory.json; the game folder is only read. */
export function register(router, { games }) {
    router.get("/api/games/:id/diagnose", ({ params }) => {
        const game = games.get(params.id);
        return { inventory: readInventory(game.workDir) };
    });

    router.post("/api/games/:id/diagnose/run", async ({ params }) => {
        const game = games.get(params.id);
        const inventory = await diagnose(game.path);
        await fsp.mkdir(game.workDir, { recursive: true });
        const file = path.join(game.workDir, "inventory.json");
        const tmp = `${file}.${process.pid}.tmp`;
        await fsp.writeFile(tmp, JSON.stringify(inventory, null, 2));
        await fsp.rename(tmp, file);
        const r = inventory.game?.resolution;
        games.updateMeta(game.id, {
            ...(r?.width && r?.height ? { resolution: `${r.width}×${r.height}` } : {}),
            lastRunAt: inventory.generatedAt,
        });
        return { inventory };
    });
}
