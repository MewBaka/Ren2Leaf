// One pass over each source file: tracks block context (label, screen, python, def) and records
// the raw facts the inventory is built from. Nothing here evaluates code.

import { lex, matchBracket, splitArgs } from "./lexer.js";
import { flowCalls, isDialogueContext, isNoiseWord, menuChoice, recordHead, storyStatement, trySay } from "./story.js";
import { classifyDefinition, classifyPython } from "./python.js";

const SNIPPET_MAX = 160;

export function snippet(text) {
    const s = text.trim().replace(/\s+/g, " ");
    return s.length > SNIPPET_MAX ? s.slice(0, SNIPPET_MAX - 1) + "…" : s;
}

/** Shared state for all files of one game. */
export class Collector {
    constructor() {
        this.screenDefs = [];
        this.callSites = [];
        this.characters = [];
        this.store = new Map(); // name -> {declaredBy, file, line}
        this.callables = new Set();
        this.transforms = new Set();
        this.info = { name: [], version: [], guiInit: [], screenWidth: [], screenHeight: [], saveDirectory: [], gameMenuScreen: [] };
        this.py2 = [];
        this.py3 = [];
        this.directives = [];
        this.review = [];
        this.lexErrors = [];
        // Facts for the speaker, python and flow steps. `says` keeps the text in memory for
        // samples only; nothing that holds every line of dialogue reaches the inventory.
        this.says = [];
        this.voiceLines = [];
        this.labels = [];
        this.edges = [];
        this.menus = [];
        this.returns = [];
        this.beats = [];
        this.audio = [];
        // What the script points at on disk: `image` definitions, the tags `show`/`scene` ask
        // for, and the audio paths. Whether the files are there is settled in assets.js.
        this.imageDefs = [];
        this.imageUses = [];
        this.audioRefs = [];
        this.pauses = [];
        this.windowStatements = [];
        this.transitions = [];   // `with X` and the with-clause of scene/show
        this.atClauses = [];     // `show x at t(args)`: which transform, with which arguments
        this.nvlStatements = [];
        this.pyEntries = [];
        this.pyModules = [];
        this.customStatements = [];
        this.unknownStatements = [];
        this.statementHeads = new Map();
        this.fileEnd = new Map();
        // persistent.* is the only store that survives a playthrough, so it is kept apart from
        // ordinary variables: it is what new-game-plus branches and gallery unlocks hang on.
        this.persistent = new Map(); // name -> {name, declaredBy, file, line, value, writes}
        this.displayables = new Map(); // define name -> constructor, so it is not read as a variable
    }

    notePersistent(name, declaredBy, file, line, value) {
        const row = this.persistent.get(name) ?? { name, declaredBy: null, file: null, line: null, value: undefined, writes: 0 };
        if (declaredBy === "default" || declaredBy === "define") {
            row.declaredBy = declaredBy;
            row.file = file;
            row.line = line;
            if (value !== undefined) row.value = value;
        } else {
            row.writes++;
            if (!row.file) {
                row.file = file;
                row.line = line;
                row.declaredBy = row.declaredBy ?? declaredBy;
            }
        }
        this.persistent.set(name, row);
    }

    declare(name, declaredBy, file, line) {
        if (!name || name.includes(".")) return;
        const prev = this.store.get(name);
        // "default" and "define" outrank incidental assignments.
        const rank = { default: 0, define: 1, python: 2, assigned: 3, action: 4 };
        if (!prev || rank[declaredBy] < rank[prev.declaredBy]) this.store.set(name, { declaredBy, file, line });
    }

    addReview(kind, ctx, ln, message) {
        this.review.push({ kind, file: ctx.file, line: ln.line, label: ctx.label ?? null, screen: ctx.screen ?? null, snippet: snippet(ln.text), message });
    }
}

/** Literal value of masked[a, b): a string (optionally wrapped in _() or __()), number, None, True, False. */
export function literalAt(ln, a, b) {
    const m = ln.masked.slice(a, b).trim();
    const off = a + ln.masked.slice(a, b).indexOf(m);
    const sm = /^(_{1,2}\s*\(\s*)?([rRuUbB]{0,2})("""|'''|"|')~*\3(\s*\))?$/.exec(m);
    if (sm && !!sm[1] === !!sm[4]) {
        const quotePos = off + (sm[1] || "").length + sm[2].length;
        const s = ln.strings.find((x) => x.start === quotePos);
        if (s) return { ok: true, value: s.value };
    }
    if (/^-?\d+(\.\d+)?$/.test(m)) return { ok: true, value: Number(m) };
    if (m === "None") return { ok: true, value: null };
    if (m === "True" || m === "False") return { ok: true, value: m === "True" };
    return { ok: false, expr: ln.text.slice(a, b).trim() };
}

/** Parses the call whose "(" is at `open`. Returns {positional, keywords, end} with [a, b) ranges. */
export function parseCall(ln, open) {
    const close = matchBracket(ln.masked, open);
    if (close < 0) return null;
    const positional = [];
    const keywords = {};
    for (const [a, b] of splitArgs(ln.masked, open + 1, close)) {
        const km = /^(\w+)\s*=(?!=)\s*/.exec(ln.masked.slice(a, b));
        if (km) keywords[km[1]] = [a + km[0].length, b];
        else positional.push([a, b]);
    }
    return { positional, keywords, end: close + 1 };
}

const PY_HEADER = /^(?:init(?:\s+[-+]?\d+)?\s+)?python\b[^:]*:$|^translate\s+\w+\s+python\b[^:]*:$/;
const CHAR_CTORS = /(?<![\w.])(Character|DynamicCharacter|NVLCharacter|ADVCharacter)\s*\(/;
const GUARD_WORDS = new Set(["if", "elif", "else", "while"]);

export function scanFile(col, file, source, { pythonFile = false } = {}) {
    const { lines, errors } = lex(source);
    for (const e of errors) col.lexErrors.push({ file, line: e.line, message: e.message });
    const stack = []; // {indent, type, name}
    let lastGlobalLabel = null;
    // What the stage shows and which voice line is pending, carried line by line through the file.
    const stage = { shown: [], background: null, voice: null, voiceSustain: false, lastSay: null, nvl: false };
    const inTl = file.startsWith("tl/");
    let lastLine = 0;

    for (const ln of lines) {
        lastLine = Math.max(lastLine, ln.endLine);
        while (stack.length && stack[stack.length - 1].indent >= ln.indent) stack.pop();
        const ctx = context(stack, file);
        ctx.stage = stage;
        ctx.inTl = inTl;
        const m = ln.masked.trim();
        const opens = m.endsWith(":");

        if (pythonFile) {
            scanPython(col, ctx, ln, ln.masked, 0, { moduleFile: true });
            if (opens) stack.push(pythonBlock(ln, m, ctx));
            continue;
        }

        if (ctx.inPython) {
            scanPython(col, ctx, ln, ln.masked, 0, {});
            if (ctx.screenDef) ctx.screenDef.body.push({ ln, python: true });
            if (opens) stack.push(pythonBlock(ln, m, ctx));
            continue;
        }

        if (ctx.screenDef) ctx.screenDef.body.push({ ln, python: m.startsWith("$") || PY_HEADER.test(m) });

        if (m.startsWith("$")) {
            const at = ln.masked.indexOf("$") + 1;
            scanPython(col, ctx, ln, ln.masked, at, { oneLiner: true });
            continue;
        }

        let hm;
        if (PY_HEADER.test(m)) {
            stack.push({ indent: ln.indent, type: "python", inScreen: !!ctx.screenDef, header: m });
            continue;
        }
        if ((hm = /^rpy\s+python\s+(\S+)/.exec(m))) {
            col.directives.push({ file, line: ln.line, value: hm[1] });
            continue;
        }
        if (!ctx.screenDef && (hm = /^label\s+([\w.]+)/.exec(m))) {
            let name = hm[1];
            // A local label belongs to the last global label, even when it is not nested in it.
            if (name.startsWith(".")) name = (ctx.globalLabel || lastGlobalLabel || "") + name;
            else lastGlobalLabel = name.split(".")[0];
            const after = hm.index + hm[0].length + (ln.masked.length - ln.masked.trimStart().length);
            const close = ln.masked[after] === "(" ? matchBracket(ln.masked, after) : -1;
            if (!inTl) {
                col.labels.push({
                    name, file, line: ln.line, indent: ln.indent, global: name.split(".")[0],
                    parameters: close > 0 ? ln.text.slice(after, close + 1) : null,
                });
                // A label can be entered from anywhere, so what the stage showed before it is no
                // longer evidence for the lines inside it.
                stage.shown = [];
                stage.background = null;
                stage.voice = null;
                stage.lastSay = null;
            }
            if (opens) stack.push({ indent: ln.indent, type: "label", name, global: name.split(".")[0] });
            continue;
        }
        if (!ctx.screenDef && (hm = /^translate\s+(\w+)\s+([\w.]+)/.exec(m))) {
            if (opens) stack.push({ indent: ln.indent, type: "translate", name: hm[2], language: hm[1] });
            continue;
        }
        if ((hm = /^screen\s+(\w+)\s*/.exec(m)) && !ctx.screenDef) {
            const def = screenHeader(col, ctx, ln, hm);
            if (opens) stack.push({ indent: ln.indent, type: "screen", name: def?.name, def });
            continue;
        }
        if (!ctx.screenDef && (hm = /^transform\s+([\w.]+)/.exec(m))) {
            col.transforms.add(hm[1]);
            if (opens) stack.push({ indent: ln.indent, type: "block" });
            continue;
        }

        const extra = scanStatement(col, ctx, ln, m);
        if (opens) {
            const word = /^([A-Za-z_]\w*)/.exec(m)?.[1] ?? null;
            const frame = { indent: ln.indent, type: /^init\b/.test(m) ? "init" : "block", word, ...(extra?.frame ?? {}) };
            // What stands between the label and the lines inside this block. A jump under
            // `if persistent.x` is a second-playthrough route, not where play starts.
            if (word && GUARD_WORDS.has(word)) frame.condition = m.slice(word.length).replace(/:$/, "").trim() || null;
            stack.push(frame);
        }
    }
    col.fileEnd.set(file, lastLine);
    if (pythonFile) col.pyModules.push({ file, lines: lines.length });
}

function pythonBlock(ln, m, ctx) {
    const dm = /^(def|class)\s+(\w+)/.exec(m);
    if (dm) return { indent: ln.indent, type: dm[1], name: dm[2], inScreen: ctx.inScreen };
    return { indent: ln.indent, type: "pyblock", inScreen: ctx.inScreen };
}

function context(stack, file) {
    const ctx = {
        file, label: null, globalLabel: null, screen: null, screenDef: null, inPython: false,
        func: null, pyClass: null, pyTop: false, inScreen: false, blockWord: null, menu: null,
        choice: null, inTranslate: false, pythonHeader: null, guards: [], imageDef: null,
    };
    let pyIdx = -1;
    for (let i = 0; i < stack.length; i++) {
        const s = stack[i];
        if (s.type === "block" || s.type === "init") ctx.blockWord = s.word ?? null;
        if (s.type === "menu") {
            ctx.menu = s.menu ?? null;
            ctx.choice = null;
            ctx.blockWord = "menu";
        } else if (s.type === "choice") {
            // A menu option's body is ordinary story, so it does not restrict what can appear.
            ctx.choice = s.choice ?? null;
            ctx.blockWord = null;
        } else if (s.type === "translate") {
            ctx.inTranslate = true;
        } else if (s.type === "imagedef") {
            ctx.imageDef = s.def ?? null;
            ctx.blockWord = "image";
        }
        if (s.type === "label") {
            ctx.label = s.name;
            ctx.globalLabel = s.global;
        } else if (s.type === "screen") {
            ctx.screen = s.name ?? null;
            ctx.screenDef = s.def ?? null;
            ctx.inScreen = true;
        } else if (s.type === "python") {
            ctx.inPython = true;
            ctx.pythonHeader = s.header ?? ctx.pythonHeader;
            if (pyIdx < 0) pyIdx = i;
        } else if (s.type === "def") ctx.func = s.name;
        else if (s.type === "class") ctx.pyClass = s.name;
        if (s.condition !== undefined) ctx.guards.push({ word: s.word ?? null, condition: s.condition ?? null });
    }
    if (ctx.inPython) ctx.pyTop = !stack.slice(pyIdx + 1).some((s) => s.type === "def" || s.type === "class");
    return ctx;
}

function screenHeader(col, ctx, ln, hm) {
    const name = hm[1];
    let signature = "";
    let params = [];
    const after = hm.index + hm[0].length + (ln.masked.length - ln.masked.trimStart().length);
    if (ln.masked[after] === "(") {
        const close = matchBracket(ln.masked, after);
        if (close > 0) {
            signature = ln.text.slice(after, close + 1);
            params = splitArgs(ln.masked, after + 1, close).map(([a, b]) => {
                const raw = ln.text.slice(a, b);
                const pm = /^(\*{0,2})(\w+)\s*(?:=\s*([\s\S]*))?$/.exec(raw.trim());
                return pm ? { name: pm[1] + pm[2], default: pm[3] != null ? pm[3].trim() : null } : { name: raw.trim(), default: null };
            });
        }
    }
    const def = { name, file: ctx.file, line: ln.line, endLine: ln.endLine, signature, params, indent: ln.indent, body: [] };
    col.screenDefs.push(def);
    return def;
}

/** Ren'Py statements outside python blocks. */
function scanStatement(col, ctx, ln, m) {
    let hm;
    // Inside `image x:` / `layeredimage x:`: every string is a file the image is built from.
    if (ctx.imageDef) {
        for (const s of ln.strings) addAssetPath(ctx.imageDef, s.value);
        return {};
    }
    if ((hm = /^(define|default)\s+(?:[-+]?\d+\s+)?([\w.]+)\s*(\+=|\|=|=)\s*/.exec(m))) {
        const [, stmt, name] = hm;
        const off = ln.masked.indexOf(hm[0]) + hm[0].length;
        if (name.startsWith("persistent.")) {
            // persistent.* is always store; nothing to declare, but it is listed on its own.
            const lit = literalAt(ln, off, ln.masked.length);
            if (!ctx.screenDef) col.notePersistent(name, stmt, ctx.file, ln.line, lit.ok ? lit.value : undefined);
        } else if (!name.includes(".")) {
            if (!ctx.screenDef) col.declare(name, stmt, ctx.file, ln.line);
        }
        configAssignment(col, ctx, ln, name, off, ln.masked.length);
        characterDef(col, ctx, ln, name, off);
        if (!ctx.screenDef) classifyDefinition(col, ctx, ln, stmt, name, off);
        scanPythonExpr(col, ctx, ln, off);
        return;
    }
    if (!ctx.screenDef && (hm = IMAGE_HEAD.exec(m))) {
        const def = imageDefinition(col, ctx, ln, hm);
        return hm[3] === ":" ? { frame: { type: "imagedef", def } } : {};
    }
    if (ctx.screenDef) {
        scanCallSites(col, ctx, ln, { screenLanguage: true });
        return;
    }
    if (ctx.menu && !ctx.choice) {
        const choice = menuChoice(col, ctx, ln, m, ctx.menu);
        if (choice) return { frame: { type: "choice", choice } };
    }
    if ((hm = /^(show|call)\s+screen\s+/.exec(m))) {
        const base = ln.masked.indexOf(hm[0]) + hm[0].length;
        statementScreen(col, ctx, ln, hm[1] + " screen", base);
        scanCallSites(col, ctx, ln, {});
        return;
    }
    if (/^menu\b/.test(m) && m.endsWith(":") && ctx.label) {
        let screen = "choice";
        const sm = /\bscreen\s*=\s*/.exec(ln.masked);
        if (sm) {
            const lit = literalAt(ln, sm.index + sm[0].length, exprEndSimple(ln, sm.index + sm[0].length));
            if (lit.ok && typeof lit.value === "string") screen = lit.value;
            else col.addReview("dynamicScreenName", ctx, ln, "menu 的 screen 参数不是字面量");
        }
        col.callSites.push(site(ctx, ln, "menu", screen, null));
    }

    const story = storyStatement(col, ctx, ln, m);
    if (story) {
        recordHead(col, ctx, ln, m);
        scanCallSites(col, ctx, ln, {});
        return story;
    }
    if (trySay(col, ctx, ln, m)) return;
    // Left over: a statement from renpy.register_statement, or a hole in the scanner. Either way
    // the port needs to know about it, so it is counted rather than dropped.
    const word = /^([A-Za-z_]\w*)/.exec(m)?.[1] ?? null;
    if (word && !isNoiseWord(word) && isDialogueContext(ctx) && !/^[\w.]+\s*(\+|-|\*|\/|\|)?=(?!=)/.test(m)) {
        col.unknownStatements.push({ word, file: ctx.file, line: ln.line, label: ctx.label ?? null, screen: ctx.screen ?? null, snippet: snippet(ln.text) });
    }
    scanCallSites(col, ctx, ln, {});
}

// `image BG_port 1 = "images/bg/BG_port_1.png"`, `image a = Movie(play=…, mask=…)`,
// `image a:` with an ATL body, `layeredimage b:`. The name may be several words; the first is
// the tag `show` asks for.
const IMAGE_HEAD = /^(image|layeredimage)\s+([A-Za-z_][\w.]*(?:\s+[\w.@-]+)*?)\s*(=|:)\s*/;
const ASSET_EXT = /\.([A-Za-z0-9]{2,5})$/;
const PLAY_PREFIX = /^<[^>]*>/;

/**
 * The file a reference string points at. Ren'Py allows a `"<loop 5>bgm.ogg"` prefix on audio, and
 * a string with no extension (a colour, a style name) is not a file at all.
 * @returns {string|null} the path with "/" separators, or null when the string is not one
 */
export function assetPath(value) {
    const s = String(value ?? "").replace(PLAY_PREFIX, "").trim().replace(/\\/g, "/");
    if (!s || s.startsWith("#") || !ASSET_EXT.test(s)) return null;
    return s;
}

function addAssetPath(def, value) {
    const p = assetPath(value);
    if (p && !def.paths.includes(p)) def.paths.push(p);
}

function imageDefinition(col, ctx, ln, hm) {
    const name = hm[2].trim().replace(/\s+/g, " ");
    const parts = name.split(" ");
    const valueAt = ln.masked.indexOf(hm[0]) + hm[0].length;
    const value = ln.masked.slice(valueAt).trim();
    const def = {
        statement: hm[1], name, tag: parts[0], attributes: parts.slice(1),
        constructor: /^([A-Za-z_][\w.]*)\s*\(/.exec(value)?.[1] ?? null,
        mask: null, paths: [],
        expression: value ? snippet(ln.text.slice(valueAt)) : null,
        file: ctx.file, line: ln.line, label: ctx.label ?? null,
    };
    if (def.constructor) {
        const open = ln.masked.indexOf("(", valueAt);
        const call = open > 0 ? parseCall(ln, open) : null;
        if (call?.keywords.mask) {
            const lit = literalAt(ln, ...call.keywords.mask);
            def.mask = lit.ok && typeof lit.value === "string" ? lit.value : "（不是字面量）";
        }
    }
    for (const s of ln.strings) if (s.start >= valueAt) addAssetPath(def, s.value);
    col.imageDefs.push(def);
    return def;
}

function exprEndSimple(ln, a) {
    const parts = splitArgs(ln.masked, a, ln.masked.length);
    if (!parts.length) return a;
    let end = parts[0][1];
    // Stop at a closing bracket that belongs to an enclosing call.
    let d = 0;
    for (let i = a; i < end; i++) {
        const c = ln.masked[i];
        if ("([{".includes(c)) d++;
        else if (")]}".includes(c)) {
            if (d === 0) return i;
            d--;
        }
    }
    return end;
}

function site(ctx, ln, kind, screen, args) {
    return { kind, screen, file: ctx.file, line: ln.line, label: ctx.label ?? null, caller: ctx.screen ?? null, func: ctx.func ?? null, args: args ? snippet(args) : null, via: null };
}

/** `show screen x(args)` / `call screen x` / `... screen expression <expr>`. */
function statementScreen(col, ctx, ln, kind, base) {
    const rest = ln.masked.slice(base);
    const em = /^expression\s+/.exec(rest);
    if (em) {
        const a = base + em[0].length;
        const end = exprEndSimple(ln, a);
        const realEnd = Math.min(end, endBeforeKeyword(ln, a));
        const lit = literalAt(ln, a, realEnd);
        if (lit.ok && typeof lit.value === "string") col.callSites.push(site(ctx, ln, kind, lit.value, null));
        else col.addReview("dynamicScreenName", ctx, ln, `${kind} expression 的界面名是运行时表达式`);
        return;
    }
    const nm = /^(\w+)/.exec(rest);
    if (!nm) {
        col.addReview("unparsed", ctx, ln, `无法解析 ${kind} 语句`);
        return;
    }
    let args = null;
    const p = base + nm[0].length;
    if (ln.masked[p] === "(") {
        const close = matchBracket(ln.masked, p);
        if (close > 0) args = ln.text.slice(p, close + 1);
    }
    col.callSites.push(site(ctx, ln, kind, nm[1], args));
}

function endBeforeKeyword(ln, a) {
    const km = /\s(?:pass|with|nopredict|onlayer|zorder|as)\b/.exec(ln.masked.slice(a));
    return km ? a + km.index : ln.masked.length;
}

const SCREEN_ACTIONS = /(?<![\w.])(ShowMenu|ShowTransient|ShowScreen|ToggleScreen|Show)\s*\(/g;
const PY_SCREEN_CALLS = /(?<![\w])renpy\.(show_screen|call_screen)\s*\(/g;

/** Call sites that can appear in any code: actions, renpy.show_screen/call_screen, overlay list. */
function scanCallSites(col, ctx, ln, { screenLanguage = false }) {
    const mk = ln.masked;
    for (const re of [SCREEN_ACTIONS, PY_SCREEN_CALLS]) {
        re.lastIndex = 0;
        let am;
        while ((am = re.exec(mk))) {
            const kind = re === PY_SCREEN_CALLS ? "renpy." + am[1] : am[1];
            const open = am.index + am[0].length - 1;
            const call = parseCall(ln, open);
            if (!call) continue;
            const first = call.positional[0] ?? call.keywords._screen_name ?? call.keywords.screen;
            const argsText = ln.text.slice(open, call.end);
            if (!first) {
                if (kind === "ShowMenu") {
                    col.callSites.push({ ...site(ctx, ln, kind, null, argsText), gameMenuDefault: true });
                } else col.addReview("unparsed", ctx, ln, `${kind}() 没有界面名参数`);
                continue;
            }
            const lit = literalAt(ln, first[0], first[1]);
            if (lit.ok && typeof lit.value === "string") col.callSites.push(site(ctx, ln, kind, lit.value, argsText));
            else col.addReview("dynamicScreenName", ctx, ln, `${kind} 的界面名不是字面量：${lit.expr ?? ""}`);
        }
    }
    if (screenLanguage) {
        const um = /^(\s*)use\s+(expression\s+)?/.exec(mk);
        if (um) {
            const a = um[0].length;
            if (um[2]) {
                const lit = literalAt(ln, a, endBeforeKeyword(ln, a));
                if (lit.ok && typeof lit.value === "string") col.callSites.push(site(ctx, ln, "use", lit.value, null));
                else col.addReview("dynamicScreenName", ctx, ln, "use expression 的界面名是运行时表达式");
            } else {
                const nm = /^\w+/.exec(mk.slice(a));
                if (nm) {
                    const p = a + nm[0].length;
                    const args = mk[p] === "(" && matchBracket(mk, p) > 0 ? ln.text.slice(p, matchBracket(mk, p) + 1) : null;
                    col.callSites.push(site(ctx, ln, "use", nm[0], args));
                }
            }
        }
    }
    const om = /\bconfig\.overlay_screens\s*(\.append\s*\(|\.extend\s*\(|\+=|=)/.exec(mk);
    if (om) {
        const from = om.index + om[0].length;
        let any = false;
        for (const s of ln.strings) {
            if (s.start >= from) {
                col.callSites.push(site(ctx, ln, "config.overlay_screens", s.value, null));
                any = true;
            }
        }
        if (!any) col.addReview("dynamicScreenName", ctx, ln, "config.overlay_screens 加入的不是字面量");
    }
    flowCalls(col, ctx, ln);
    const rim = /(?<![\w.])renpy\.image\s*\(/.exec(mk);
    if (rim) {
        const first = ln.strings.find((s) => s.start > rim.index);
        if (first && /^[A-Za-z_]/.test(first.value)) {
            const parts = first.value.trim().split(/\s+/);
            col.imageDefs.push({
                statement: "renpy.image", name: parts.join(" "), tag: parts[0], attributes: parts.slice(1),
                constructor: null, mask: null,
                paths: ln.strings.filter((s) => s.start > first.start).map((s) => assetPath(s.value)).filter(Boolean),
                expression: snippet(ln.text), file: ctx.file, line: ln.line, label: ctx.label ?? null,
            });
        }
    }
    if (/(?<![\w])renpy\.define_screen\s*\(/.test(mk)) col.addReview("dynamicScreenDefinition", ctx, ln, "用 renpy.define_screen 动态定义界面");
    if (/(?<![\w])renpy\.input\s*\(/.test(mk) && !ctx.screenDef) col.callSites.push(site(ctx, ln, "renpy.input", "input", null));
}

/** define/assignment of config.* and gui.init. */
function configAssignment(col, ctx, ln, name, a, b) {
    const map = {
        "config.name": "name",
        "config.version": "version",
        "config.screen_width": "screenWidth",
        "config.screen_height": "screenHeight",
        "config.save_directory": "saveDirectory",
        _game_menu_screen: "gameMenuScreen",
    };
    const key = map[name];
    if (!key) return;
    const lit = literalAt(ln, a, b);
    col.info[key].push({ file: ctx.file, line: ln.line, ok: lit.ok, value: lit.ok ? lit.value : null, expr: lit.ok ? null : lit.expr, snippet: snippet(ln.text) });
}

function characterDef(col, ctx, ln, variable, off) {
    const cm = CHAR_CTORS.exec(ln.masked.slice(off));
    if (!cm || ln.masked.slice(off, off + cm.index).trim()) return;
    const open = off + cm.index + cm[0].length - 1;
    const call = parseCall(ln, open);
    if (!call) return;
    const ctor = cm[1];
    const entry = { variable, constructor: ctor, displayName: null, nameExpression: null, kind: null, kindSource: null, image: null, screen: null, file: ctx.file, line: ln.line, label: ctx.label ?? null };
    const nameArg = call.positional[0] ?? call.keywords.name;
    Object.defineProperty(entry, "nameGiven", { value: !!nameArg, enumerable: false });
    if (ctor === "DynamicCharacter") {
        if (nameArg) {
            const lit = literalAt(ln, nameArg[0], nameArg[1]);
            entry.nameExpression = lit.ok ? `[${lit.value}]` : lit.expr;
        }
    } else if (nameArg) {
        const lit = literalAt(ln, nameArg[0], nameArg[1]);
        if (lit.ok) entry.displayName = lit.value === null ? null : String(lit.value);
        else {
            entry.nameExpression = lit.expr;
            col.addReview("dynamicCharacterName", ctx, ln, `角色 ${variable} 的显示名是表达式：${lit.expr}`);
        }
    }
    if (call.keywords.kind) {
        entry.kindSource = ln.text.slice(...call.keywords.kind).trim();
    } else if (ctor === "NVLCharacter") entry.kindSource = "nvl";
    for (const k of ["image", "screen"]) {
        if (!call.keywords[k]) continue;
        const lit = literalAt(ln, ...call.keywords[k]);
        if (lit.ok) entry[k] = lit.value;
        else {
            entry[k] = null;
            col.addReview(k === "screen" ? "dynamicScreenName" : "dynamicCharacterImage", ctx, ln, `角色 ${variable} 的 ${k}= 不是字面量：${lit.expr}`);
        }
    }
    if (entry.screen) col.callSites.push(site(ctx, ln, "Character(screen=)", entry.screen, null));
    if (typeof entry.image === "string" && entry.image.trim()) {
        const tag = entry.image.trim().split(/\s+/);
        col.imageUses.push({ statement: "Character(image=)", tag: tag[0], attributes: tag.slice(1), file: ctx.file, line: ln.line, label: ctx.label ?? null });
    }
    col.characters.push(entry);
}

// ---- Python ----------------------------------------------------------------------------------

const PY2_SYNTAX = [
    { rule: "printStatement", re: /^print(?:\s*>>|\s+(?![\s(=,)\].:;]|$|if\b|else\b|and\b|or\b|in\b))/, message: "print 语句" },
    { rule: "execStatement", re: /^exec\s+(?![(=])/, message: "exec 语句" },
    { rule: "exceptComma", re: /^except\s+[\w.]+\s*,\s*\w+\s*:/, message: "except X, e:" },
    { rule: "raiseComma", re: /^raise\s+[\w.]+\s*,/, message: "raise E, msg" },
    { rule: "backtick", re: /`/, message: "反引号 repr" },
    { rule: "diamondOperator", re: /<>/, message: "<> 运算符" },
    { rule: "longLiteral", re: /(?<![\w.])\d+[lL](?!\w)/, message: "长整型字面量 123L" },
    { rule: "octalLiteral", re: /(?<![\w.])0[0-7]*[1-7][0-7]*(?![\w.])/, message: "旧式八进制 0777" },
];
const PY2_API = [
    { rule: "py2Builtin", re: /(?<![\w.])(xrange|raw_input|unichr|execfile|reload|cmp|reduce)\s*\(/, message: "Python 2 内置函数" },
    { rule: "py2Builtin", re: /(?<![\w.])(unicode|long|basestring)(?![\w])/, message: "Python 2 内置类型" },
    { rule: "py2DictMethod", re: /\.(has_key|iteritems|itervalues|iterkeys)\s*\(/, message: "Python 2 字典方法" },
    { rule: "py2Module", re: /^(?:import|from)\s+(cPickle|urllib2|ConfigParser|Queue|StringIO|cStringIO|__builtin__|HTMLParser|httplib|urlparse|commands)\b/, message: "Python 2 模块" },
    { rule: "py2Attr", re: /\bsys\.maxint\b|\bstring\.(letters|lowercase|uppercase)\b/, message: "Python 2 属性" },
];

/** Python syntax checks and py3-only clues on masked[from..]. */
function pyChecks(col, ctx, ln, code, from) {
    const stmt = code.trim();
    const hit = (rule, severity, message) => col.py2.push({ rule, severity, file: ctx.file, line: ln.line, snippet: snippet(ln.text.slice(from)), message });
    for (const r of PY2_SYNTAX) if (r.re.test(stmt)) hit(r.rule, "syntax", r.message);
    for (const r of PY2_API) if (r.re.test(stmt)) hit(r.rule, "api", r.message);
    for (const s of ln.strings) {
        if (s.start < from) continue;
        const p = s.prefix.toLowerCase();
        if (p === "ur" || p === "ru") hit("urPrefix", "syntax", "ur'' 前缀");
        if (p.includes("f")) col.py3.push({ rule: "fString", file: ctx.file, line: ln.line, snippet: snippet(ln.text.slice(from)) });
    }
    if (/^nonlocal\b/.test(stmt)) col.py3.push({ rule: "nonlocal", file: ctx.file, line: ln.line, snippet: snippet(ln.text) });
    if (/:=/.test(stmt)) col.py3.push({ rule: "walrus", file: ctx.file, line: ln.line, snippet: snippet(ln.text) });
}

function scanPythonExpr(col, ctx, ln, from) {
    pyChecks(col, ctx, ln, ln.masked.slice(from), from);
    scanCallSites(col, ctx, ln, {});
    storeHints(col, ctx, ln, from);
}

/** A python line: in a python block, after `$`, or in a .py file. */
function scanPython(col, ctx, ln, masked, from, { oneLiner = false, moduleFile = false }) {
    const code = masked.slice(from);
    const stmt = code.trim();
    pyChecks(col, ctx, ln, code, from);
    // Screen-local python belongs to the interface step, not to step ④.
    if (!ctx.inScreen && (!moduleFile || /^(?:async\s+)?(?:def|class)\s/.test(stmt))) {
        const where = moduleFile ? "pyFile" : oneLiner ? "dollar" : /^init\b/.test(ctx.pythonHeader ?? "") ? "initPython" : "python";
        classifyPython(col, ctx, ln, { from, context: where, nested: !(ctx.pyTop || oneLiner || moduleFile) });
    }
    if (moduleFile) return;
    scanCallSites(col, ctx, ln, {});
    storeHints(col, ctx, ln, from);

    const dm = /^(def|class)\s+(\w+)/.exec(stmt);
    if (dm && ctx.pyTop && !ctx.inScreen) col.callables.add(dm[2]);

    const gm = /^global\s+(.+)$/.exec(stmt);
    if (gm && ctx.func) for (const n of gm[1].split(",")) col.declare(n.trim(), "python", ctx.file, ln.line);

    // Top-level assignments in init python / label python become store variables.
    const am = /^([A-Za-z_][\w.]*(?:\s*,\s*[A-Za-z_][\w.]*)*)\s*(?:[-+*\/|&%]|\/\/)?=(?!=)/.exec(stmt);
    if (am && !ctx.inScreen && (oneLiner || ctx.pyTop)) {
        const kind = ctx.label || oneLiner ? "assigned" : "python";
        for (const raw of am[1].split(",")) {
            const n = raw.trim();
            if (n.startsWith("store.")) col.declare(n.slice(6), kind, ctx.file, ln.line);
            else col.declare(n, kind, ctx.file, ln.line);
        }
        const name = am[1].trim();
        const valueAt = ln.masked.indexOf(am[0], from) + am[0].length;
        configAssignment(col, ctx, ln, name, valueAt, ln.masked.length);
        if (!name.includes(",")) characterDef(col, ctx, ln, name, valueAt);
    }

    const gi = /(?<![\w])gui\.init\s*\(/.exec(code);
    if (gi) {
        const open = from + gi.index + gi[0].length - 1;
        const call = parseCall(ln, open);
        const w = call?.positional[0] && literalAt(ln, ...call.positional[0]);
        const h = call?.positional[1] && literalAt(ln, ...call.positional[1]);
        const ok = !!(w?.ok && h?.ok && typeof w.value === "number" && typeof h.value === "number");
        col.info.guiInit.push({ file: ctx.file, line: ln.line, ok, value: ok ? [w.value, h.value] : null, expr: ok ? null : snippet(ln.text.slice(from)), snippet: snippet(ln.text) });
    }
}

/** store.x = …, SetVariable("x") and friends: names the game writes into the store. */
function storeHints(col, ctx, ln, from) {
    const mk = ln.masked;
    let m;
    const sre = /(?<![\w.])store\.(\w+)\s*(?:[-+*\/|&%]|\/\/)?=(?!=)/g;
    sre.lastIndex = from;
    while ((m = sre.exec(mk))) col.declare(m[1], "assigned", ctx.file, ln.line);
    const vre = /(?<![\w.])(SetVariable|ToggleVariable|IncrementVariable|CycleVariable|VariableValue|VariableInputValue)\s*\(\s*/g;
    vre.lastIndex = from;
    while ((m = vre.exec(mk))) {
        const s = ln.strings.find((x) => x.start === m.index + m[0].length);
        if (s && /^\w+$/.test(s.value)) col.declare(s.value, "action", ctx.file, ln.line);
    }
}
