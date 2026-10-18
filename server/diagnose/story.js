// The story side of the one pass: say statements with the voice line and sprites that go with them,
// label and menu structure, jump/call edges, and the stage changes that hint where a chapter ends.
// Nothing here evaluates code; a say's text is kept in memory for samples only.

import { depthMap } from "./lexer.js";
import { isPropertyName } from "./vocab.js";
import { literalAt, parseCall, snippet } from "./scan.js";

/** Ren'Py statement keywords. A line starting with one of these is never a say statement. */
const STATEMENTS = new Set([
    "label", "jump", "call", "return", "menu", "set", "if", "elif", "else", "while", "pass",
    "python", "init", "define", "default", "image", "transform", "screen", "style", "translate",
    "old", "new", "voice", "play", "stop", "queue", "pause", "scene", "show", "hide", "with",
    "window", "nvl", "camera", "add", "use", "transclude", "rpy", "layeredimage", "attribute",
    "group", "always", "multiple", "sticky", "auto", "offset", "block", "parallel", "choice",
    "repeat", "time", "function", "contains", "event", "on", "key", "timer", "showif", "has",
    "testcase", "zorder", "behind", "onlayer", "expression", "at", "as", "from", "nointeract",
    "extend", "say", "import", "del", "assert", "raise", "print", "for", "in", "not", "and", "or",
    "monologue", "default_statement", "early", "hyperlink",
]);

/** Blocks whose body is a property list or ATL, never dialogue. */
const NOT_DIALOGUE_BLOCKS = new Set([
    "style", "show", "scene", "hide", "transform", "image", "layeredimage", "camera", "screen",
    "python", "init", "translate", "old", "new", "define", "default", "testcase", "window",
    // ATL blocks, which nest inside the statements above and inside each other.
    "block", "parallel", "repeat", "choice", "time", "on", "event", "contains", "function",
    "animation", "subpixel",
]);

/** ATL time warpers; a line starting with one is animation, not a statement. */
const WARPER = /^(?:linear|ease|easein|easeout|ease_\w+|easein_\w+|easeout_\w+|warp\.\w+)$/;

const MOVIE_NAME = /(?:^|[\/_\-])(op|ed|opening|ending|title|logo|prologue|epilogue)(?:\d*)(?:[\/_\-.]|$)/i;

/** A voice file's folder, which is the strongest evidence of who an aliased variable is. */
export function voiceDir(file) {
    const p = String(file).replace(/\\/g, "/");
    const at = p.lastIndexOf("/");
    return at > 0 ? p.slice(0, at) : "";
}

function stringsAtDepth0(ln) {
    const depth = depthMap(ln.masked);
    return ln.strings.filter((s) => (depth[s.start] ?? 0) === 0);
}

const INTERPOLATION = /\[([A-Za-z_][\w.]*)/g;
const TEXT_TAG = /\{\/?([a-z_]+)/gi;

function textFeatures(text) {
    const vars = new Set();
    const tags = new Set();
    let m;
    INTERPOLATION.lastIndex = 0;
    while ((m = INTERPOLATION.exec(text))) vars.add(m[1]);
    TEXT_TAG.lastIndex = 0;
    while ((m = TEXT_TAG.exec(text))) tags.add(m[1].toLowerCase());
    return { interpolations: [...vars], textTags: [...tags] };
}

/**
 * A say statement: `e "…"`, `e happy "…"`, `"Name" "…"`, `"…"` or `extend "…"`.
 * @returns {object|null} the record, or null when the line is not a say
 */
function parseSay(ctx, ln, m) {
    const strs = stringsAtDepth0(ln);
    if (!strs.length) return null;
    const lead = ln.masked.length - ln.masked.trimStart().length;
    const first = strs[0];
    const prefix = ln.masked.slice(lead, first.start).trim();
    const base = {
        file: ctx.file, line: ln.line, endLine: ln.endLine, label: ctx.label ?? null,
        speaker: null, inlineName: null, attributes: [], text: null,
    };

    if (!prefix) {
        // `"Name" "text"` is a one-off speaker; a lone string is narration.
        const second = strs[1];
        if (second && !ln.masked.slice(first.end, second.start).trim()) {
            return { ...base, kind: "inline", inlineName: first.value, text: second.value };
        }
        return { ...base, kind: "narrator", text: first.value };
    }
    if (/^extend\b/.test(prefix)) return { ...base, kind: "extend", text: first.value };
    const pm = /^([A-Za-z_]\w*)((?:\s+(?:@|[-+]?[\w.]+))*)$/.exec(prefix);
    if (!pm || STATEMENTS.has(pm[1])) return null;
    const attributes = pm[2].trim().split(/\s+/).filter((a) => a && a !== "@");
    return { ...base, kind: "say", speaker: pm[1], attributes, text: first.value };
}

function recordSay(col, ctx, say) {
    const stage = ctx.stage;
    if (say.kind === "extend" && stage.lastSay) {
        say.speaker = stage.lastSay.speaker;
        say.inlineName = stage.lastSay.inlineName;
    }
    say.voice = stage.voice;
    say.voiceDir = stage.voice ? voiceDir(stage.voice) : null;
    say.sprite = stage.shown.length ? stage.shown[stage.shown.length - 1].tag : null;
    say.shown = stage.shown.map((s) => s.tag);
    say.background = stage.background;
    say.nvl = stage.nvl;
    Object.assign(say, textFeatures(say.text ?? ""));
    col.says.push(say);
    if (say.kind !== "extend") stage.lastSay = say;
    // `voice` covers the next line only; `voice sustain` keeps it for the one after.
    if (!stage.voiceSustain) stage.voice = null;
    stage.voiceSustain = false;
}

/** The first depth-0 string of a statement, as a literal value. */
function firstLiteral(ln) {
    const s = stringsAtDepth0(ln)[0];
    return s ? s.value : null;
}

const PERSISTENT_READ = /(?<![\w.])persistent\s*\./;

function edge(col, ctx, ln, kind, to, expr) {
    // The `if`/`while` conditions this jump sits under. One that reads persistent.* can only be
    // taken on a later playthrough, so it is not part of where a first play goes.
    const guards = (ctx.guards ?? []).filter((g) => g.condition).map((g) => `${g.word} ${g.condition}`);
    const e = {
        kind, from: ctx.label ?? null, to: to ?? null, expr: expr ?? null, file: ctx.file,
        line: ln.line, indent: ln.indent, screen: ctx.screen ?? null,
        guards: guards.length ? guards : null,
        persistentGuard: guards.some((g) => PERSISTENT_READ.test(g)),
    };
    col.edges.push(e);
    if (ctx.choice && !ctx.choice.target && to) ctx.choice.target = to;
    return e;
}

const WITH_CLAUSE = /\bwith\s+([^\s].*?)\s*$/;
const AT_CLAUSE = /\bat\s+([^\s].*?)(?=\s+(?:with|behind|onlayer|zorder|as|nopredict)\b|\s*$)/;

/** `with dissolve`, and the with-clause of a scene/show line. Counted, never evaluated. */
function noteTransition(col, ctx, ln, expr) {
    const text = String(expr ?? "").trim();
    if (!text || text === "None") return;
    const name = /^([A-Za-z_][\w.]*)/.exec(text)?.[1] ?? text;
    col.transitions.push({ name, expression: snippet(text), file: ctx.file, line: ln.line, label: ctx.label ?? null });
}

/** Splits `a, b(1, 2), c` on the commas that are not inside brackets. */
function topLevelParts(text) {
    const out = [];
    let depth = 0;
    let start = 0;
    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if ("([{".includes(c)) depth++;
        else if (")]}".includes(c)) depth--;
        else if (c === "," && depth === 0) {
            out.push(text.slice(start, i));
            start = i + 1;
        }
    }
    out.push(text.slice(start));
    return out;
}

/** `at t`, `at t(9999)`, `at a, b`: which transform runs on a sprite, with which arguments. */
function noteAt(col, ctx, ln, m, tag) {
    const am = AT_CLAUSE.exec(m);
    if (!am) return;
    for (const part of topLevelParts(am[1])) {
        const text = part.trim();
        if (!text) continue;
        const name = /^([A-Za-z_][\w.]*)/.exec(text)?.[1] ?? null;
        if (!name) continue;
        const args = /\(([^)]*)\)/.exec(text)?.[1]?.trim() || null;
        const numbers = (args ?? "").match(/-?\d+(?:\.\d+)?/g)?.map(Number) ?? [];
        col.atClauses.push({
            transform: name, tag: tag ?? null, arguments: args, numbers,
            file: ctx.file, line: ln.line, label: ctx.label ?? null,
        });
    }
}

function beat(col, ctx, ln, kind, evidence) {
    col.beats.push({ kind, file: ctx.file, line: ln.line, label: ctx.label ?? null, evidence: evidence ?? null, snippet: snippet(ln.text) });
}

/**
 * One Ren'Py statement outside screens and python blocks.
 * @returns {object|null} null when the statement is not one of these, otherwise an object whose
 *   optional `frame` is pushed onto the block stack (a `menu:` needs one so its options are found)
 */
export function storyStatement(col, ctx, ln, m) {
    const stage = ctx.stage;
    const word = /^([A-Za-z_]\w*)/.exec(m)?.[1] ?? "";
    let hm;

    // ---- stage ----
    if (word === "scene") {
        const rest = m.slice(5).trim();
        const attrs = rest.split(/\s+/).filter(Boolean);
        const stop = attrs.findIndex((a) => ["with", "onlayer", "at", "behind", "as", "zorder"].includes(a));
        const tags = (stop < 0 ? attrs : attrs.slice(0, stop)).filter((a) => a !== "expression");
        stage.shown = [];
        stage.background = tags.join(" ") || null;
        // `scene` with no image clears the screen to black; so do the usual black/white images.
        if (!tags.length) beat(col, ctx, ln, "blackout", "scene（清空画面）");
        else if (tags.some((t) => /^(black|white|bg_black|bg_white)$/i.test(t))) beat(col, ctx, ln, "blackout", `scene ${tags.join(" ")}`);
        if (/\bwith\s+(fade|Fade\s*\()/.test(m)) beat(col, ctx, ln, "blackout", "with fade");
        if (attrs.includes("with")) noteTransition(col, ctx, ln, WITH_CLAUSE.exec(m)?.[1]);
        noteAt(col, ctx, ln, m, tags[0] ?? null);
        return {};
    }
    if (word === "show" || word === "hide") {
        const rest = m.slice(word.length).trim();
        if (/^screen\b/.test(rest)) return null;
        const attrs = rest.split(/\s+/).filter(Boolean);
        const stop = attrs.findIndex((a) => ["with", "onlayer", "at", "behind", "as", "zorder", "nopredict"].includes(a));
        const tags = stop < 0 ? attrs : attrs.slice(0, stop);
        const tag = tags[0];
        if (tag && /^[A-Za-z_]/.test(tag)) {
            stage.shown = stage.shown.filter((s) => s.tag !== tag);
            if (word === "show") stage.shown.push({ tag, attributes: tags.slice(1) });
        }
        if (word === "show" && /^movie\b/.test(rest)) beat(col, ctx, ln, "movie", rest);
        if (attrs.includes("with")) noteTransition(col, ctx, ln, WITH_CLAUSE.exec(m)?.[1]);
        if (word === "show") noteAt(col, ctx, ln, m, tag ?? null);
        return {};
    }
    if (word === "with") {
        if (/^with\s+(fade|Fade\s*\()/.test(m)) beat(col, ctx, ln, "blackout", "with fade");
        noteTransition(col, ctx, ln, m.slice(4).trim());
        return {};
    }
    if (word === "window") {
        col.windowStatements.push({ file: ctx.file, line: ln.line, label: ctx.label ?? null, action: m.slice(6).trim() });
        return {};
    }
    if (word === "nvl") {
        const action = m.slice(3).trim();
        if (/^clear/.test(action)) stage.nvl = false;
        else if (/^show/.test(action)) stage.nvl = true;
        else if (/^hide/.test(action)) stage.nvl = false;
        col.nvlStatements.push({ file: ctx.file, line: ln.line, label: ctx.label ?? null, action });
        return {};
    }

    // ---- audio and video ----
    if (word === "voice") {
        if (/^voice\s+sustain/.test(m)) {
            stage.voiceSustain = true;
            return {};
        }
        const file = firstLiteral(ln);
        if (file) {
            stage.voice = file;
            col.voiceLines.push({ file: ctx.file, line: ln.line, label: ctx.label ?? null, audio: file, dir: voiceDir(file) });
        } else {
            col.addReview("dynamicVoice", ctx, ln, "voice 的文件名不是字面量，无法作为身份证据");
        }
        return {};
    }
    if (word === "play" || word === "queue" || word === "stop") {
        const channel = /^\w+\s+(\w+)/.exec(m)?.[1] ?? null;
        const audio = firstLiteral(ln);
        col.audio.push({ statement: word, channel, audio, file: ctx.file, line: ln.line, label: ctx.label ?? null });
        if (word === "stop" && channel === "music") beat(col, ctx, ln, "stopMusic", m.trim());
        if (word === "play" && channel === "music") beat(col, ctx, ln, "music", audio ?? m.trim());
        if (word === "play" && channel === "movie") beat(col, ctx, ln, MOVIE_NAME.test(audio ?? "") ? "opEd" : "movie", audio ?? m.trim());
        return {};
    }
    if (word === "pause") {
        const t = /^pause\s+([\d.]+)/.exec(m);
        col.pauses.push({ file: ctx.file, line: ln.line, label: ctx.label ?? null, seconds: t ? Number(t[1]) : null });
        // `voice` plays at the next interaction, and a pause is one: the clip belongs to the pause,
        // not to the line after it.
        stage.voice = null;
        stage.voiceSustain = false;
        return {};
    }

    // ---- flow ----
    if ((hm = /^(jump|call)\s+(expression\s+)?(.*)$/.exec(m))) {
        const kind = hm[1];
        if (hm[2]) {
            const lit = firstLiteral(ln, m);
            if (lit) edge(col, ctx, ln, kind, lit, null);
            else {
                edge(col, ctx, ln, `${kind}Expression`, null, snippet(hm[3]));
                col.addReview("dynamicJump", ctx, ln, `${kind} expression 的目标是运行时表达式`);
            }
        } else {
            const nm = /^([\w.]+)/.exec(hm[3]);
            if (nm) edge(col, ctx, ln, kind, nm[1], null);
            else col.addReview("unparsed", ctx, ln, `无法解析 ${kind} 语句`);
        }
        return {};
    }
    if (/^return\b/.test(m)) {
        col.returns.push({ file: ctx.file, line: ln.line, indent: ln.indent, label: ctx.label ?? null, value: m.slice(6).trim() || null });
        return {};
    }
    if (word === "menu") {
        const menu = {
            file: ctx.file, line: ln.line, label: ctx.label ?? null, screen: null, caption: null,
            choices: [],
        };
        const sm = /\bscreen\s*=\s*/.exec(ln.masked);
        if (sm) {
            const lit = literalAt(ln, sm.index + sm[0].length, ln.masked.length);
            if (lit.ok && typeof lit.value === "string") menu.screen = lit.value;
        }
        col.menus.push(menu);
        // A menu is an interaction too, so it takes a pending voice with it.
        stage.voice = null;
        stage.voiceSustain = false;
        return { frame: { type: "menu", menu } };
    }
    return null;
}

/**
 * A line inside a `menu:` block: a choice (`"text" (cond):`), its caption, or `set`.
 * @returns {object|null} the choice record when the line opens one
 */
export function menuChoice(col, ctx, ln, m, menu) {
    const strs = stringsAtDepth0(ln);
    const lead = ln.masked.length - ln.masked.trimStart().length;
    if (!strs.length || strs[0].start !== lead) return null;
    const after = ln.masked.slice(strs[0].end).trim();
    if (!m.endsWith(":")) {
        if (!after && !menu.caption) menu.caption = strs[0].value;
        return null;
    }
    // After the text: an optional `(args)` and an optional `if <condition>`.
    let rest = ln.text.slice(strs[0].end).trim().replace(/:$/, "").trim();
    let args = null;
    const am = /^\(([\s\S]*)\)/.exec(rest);
    if (am) {
        args = am[1].trim() || null;
        rest = rest.slice(am[0].length).trim();
    }
    const im = /^if\s+([\s\S]+)$/.exec(rest);
    const choice = {
        text: strs[0].value,
        condition: im ? im[1].trim() : null,
        arguments: args,
        line: ln.line,
        target: null,
    };
    menu.choices.push(choice);
    return choice;
}

const FLOW_ACTIONS = /(?<![\w.])(Jump|Call|Start|Replay)\s*\(/g;
const FLOW_PY = /(?<![\w.])renpy\.(jump|call|jump_out_of_context|call_in_new_context|call_replay|invoke_in_new_context)\s*\(/g;

/** Jump()/Call() actions and renpy.jump/call, which can appear in screens and python alike. */
export function flowCalls(col, ctx, ln) {
    for (const re of [FLOW_ACTIONS, FLOW_PY]) {
        re.lastIndex = 0;
        let am;
        while ((am = re.exec(ln.masked))) {
            const name = am[1];
            const open = am.index + am[0].length - 1;
            const call = parseCall(ln, open);
            if (!call) continue;
            const kind = re === FLOW_PY ? `renpy.${name}` : `${name}()`;
            const arg = call.positional[0];
            if (!arg) continue;
            const lit = literalAt(ln, arg[0], arg[1]);
            if (lit.ok && typeof lit.value === "string") edge(col, ctx, ln, kind, lit.value, null);
            else {
                edge(col, ctx, ln, kind, null, lit.expr ?? null);
                col.addReview("dynamicJump", ctx, ln, `${kind} 的目标不是字面量：${lit.expr ?? ""}`);
            }
        }
    }
    if (/(?<![\w.])achievement\.grant\s*\(/.test(ln.masked)) {
        beat(col, ctx, ln, "achievement", firstLiteral(ln) ?? "achievement.grant");
    }
    if (/(?<![\w.])renpy\.movie_cutscene\s*\(/.test(ln.masked)) {
        const f = firstLiteral(ln);
        beat(col, ctx, ln, MOVIE_NAME.test(f ?? "") ? "opEd" : "movie", f ?? "renpy.movie_cutscene");
    }
}

/** True when a line at this spot could be dialogue: inside a label, not in ATL or a property list. */
export function isDialogueContext(ctx) {
    if (ctx.inTranslate || ctx.inTl || !ctx.label) return false;
    return !(ctx.blockWord && NOT_DIALOGUE_BLOCKS.has(ctx.blockWord));
}

/**
 * Words that are not custom statements even though the scanner does not handle them as statements:
 * Ren'Py's own keywords, ATL warpers, and style or transform property names.
 */
export function isNoiseWord(word) {
    return STATEMENTS.has(word) || WARPER.test(word) || isPropertyName(word);
}

/**
 * Counts the first two words of a recognised statement. A statement registered with
 * renpy.register_statement can be several words long (`show example`), and by then the first word
 * has already been handled as Ren'Py's own; this is how those uses are found again.
 */
export function recordHead(col, ctx, ln, m) {
    if (!isDialogueContext(ctx)) return;
    const hm = /^([a-z_]\w*)\s+([A-Za-z_]\w*)(?=\s|$)/.exec(m);
    if (!hm) return;
    const key = `${hm[1]} ${hm[2]}`;
    const row = col.statementHeads.get(key) ?? { count: 0, sites: [] };
    row.count++;
    if (row.sites.length < 10) row.sites.push({ file: ctx.file, line: ln.line, label: ctx.label ?? null, snippet: snippet(ln.text) });
    col.statementHeads.set(key, row);
}

/** Collects a say statement when the line is one. Returns true when it was. */
export function trySay(col, ctx, ln, m) {
    if (!isDialogueContext(ctx)) return false;
    const say = parseSay(ctx, ln, m);
    if (!say) return false;
    recordSay(col, ctx, say);
    return true;
}
