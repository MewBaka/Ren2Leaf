// Builds the screen list from the collected definitions and call sites: parameters, store
// variables a screen reads, action kinds, and a first guess at the porting route
// (dialogue_like -> /nvl + NVL screen, interactive -> page + /blueprint).

import { depthMap, exprEnd, matchBracket, splitArgs } from "./lexer.js";
import { literalAt } from "./scan.js";
import {
    STANDARD_SCREENS, ENGINE_SCREENS, PY_KEYWORDS, PY_BUILTINS, SCREEN_KEYWORDS, DISPLAYABLES,
    CLICKABLE, NAMESPACES, ENGINE_STORE, ENGINE_DEFINES, RENPY_CALLABLES, isPropertyName,
} from "./vocab.js";

const STANDARD = new Set(STANDARD_SCREENS);
const ACTION_PROPS = /(?<![\w.])(action|alternate|hovered|unhovered)\s+/g;
const IDENT = /(?<![\w.$])[A-Za-z_]\w*/g;

export function screenCategory(name) {
    if (STANDARD.has(name)) return "standard";
    if (name.startsWith("_") || ENGINE_SCREENS.has(name)) return "engine";
    return "custom";
}

function bodyCode(item) {
    const m = item.ln.masked;
    if (item.python) {
        const at = m.trimStart().startsWith("$") ? m.indexOf("$") + 1 : 0;
        return { from: at, code: m.slice(at) };
    }
    return { from: 0, code: m };
}

function addTargets(set, s) {
    for (const t of s.replace(/[()\[\]*]/g, " ").split(/[\s,]+/)) if (/^[A-Za-z_]\w*$/.test(t)) set.add(t);
}

function analyzeDefinition(def, col) {
    const locals = new Set(def.params.map((p) => p.name.replace(/^\*+/, "")));
    const meta = { variant: null, tag: null, zorder: null, modal: null };
    const bodyIndent = def.body.length ? def.body[0].ln.indent : 0;
    const elements = {};
    const actions = {};
    const clickable = {};
    const dialogue = [];
    const customDisplayables = new Set();
    const localDisplayables = new Map();

    // Pass 1: names local to the screen (parameters, default, for targets, assignments, as).
    for (const item of def.body) {
        const { code } = bodyCode(item);
        const stmt = code.trim();
        let m;
        if (!item.python && (m = /^default\s+(\w+)\s*=\s*([A-Za-z_]\w*\s*\()?/.exec(stmt))) {
            locals.add(m[1]);
            const cls = m[2] && m[2].replace(/[\s(]/g, "");
            if (cls && col.callables.has(cls)) localDisplayables.set(m[1], cls);
        }
        if (item.python && (m = /^([A-Za-z_][\w\s,]*?)\s*(?:[-+*\/|&%]|\/\/)?=(?!=)/.exec(stmt))) addTargets(locals, m[1]);
        if (item.python && (m = /^(?:def|class)\s+(\w+)/.exec(stmt))) locals.add(m[1]);
        const fre = /\bfor\s+([\w\s,()]+?)\s+in\b/g;
        while ((m = fre.exec(code))) addTargets(locals, m[1]);
        const lre = /\blambda\b([^:]*):/g;
        while ((m = lre.exec(code))) addTargets(locals, m[1].replace(/=[^,]*/g, ""));
        const are = /\bas\s+(\w+)/g;
        while ((m = are.exec(code))) locals.add(m[1]);

        if (!item.python && item.ln.indent === bodyIndent && (m = /^(variant|tag|zorder|modal)\s+/.exec(stmt))) {
            const a = item.ln.masked.indexOf(m[0]) + m[0].length;
            const lit = literalAt(item.ln, a, item.ln.masked.length);
            meta[m[1]] = lit.ok ? lit.value : item.ln.text.slice(a).trim();
        }
    }

    // Pass 2: elements, actions and the names read.
    const vars = new Map();
    const unresolved = new Set();
    const consider = (name, attr) => {
        if (name === "persistent" && attr) return void vars.set(`persistent.${attr}`, "persistent");
        if (name === "store" && attr) name = attr;
        if (locals.has(name)) return;
        if (PY_KEYWORDS.has(name) || PY_BUILTINS.has(name) || SCREEN_KEYWORDS.has(name) || NAMESPACES.has(name)) return;
        if (ENGINE_DEFINES.has(name) || RENPY_CALLABLES.has(name) || isPropertyName(name)) return;
        if (col.callables.has(name) || col.transforms.has(name)) return;
        const decl = col.store.get(name);
        if (decl) vars.set(name, decl.declaredBy);
        else if (ENGINE_STORE.has(name)) vars.set(name, "engine");
        else unresolved.add(name);
    };

    for (const item of def.body) {
        const { ln } = item;
        const { from, code } = bodyCode(item);
        const stmt = code.trim();

        if (!item.python) {
            let kw = (/^\w+/.exec(stmt) || [""])[0];
            if (kw === "has") kw = (/^has\s+(\w+)/.exec(stmt) || [, ""])[1];
            if (DISPLAYABLES.has(kw)) elements[kw] = (elements[kw] || 0) + 1;
            if (CLICKABLE.has(kw) && !((kw === "bar" || kw === "vbar") && /\bvalue\s+(StaticValue|AnimatedValue)\b/.test(stmt))) {
                clickable[kw] = (clickable[kw] || 0) + 1;
            }
            const cd = kw === "add" && /^add\s+([A-Za-z_]\w*)\s*\(/.exec(stmt);
            if (cd && col.callables.has(cd[1])) customDisplayables.add(cd[1]);
            const ld = kw === "add" && /^add\s+(\w+)\s*(?::|$|\s)/.exec(stmt);
            if (ld && localDisplayables.has(ld[1])) customDisplayables.add(localDisplayables.get(ld[1]));
            if (kw === "text" && /^text\s+(who|what)\b/.test(stmt)) dialogue.push(`text ${/^text\s+(\w+)/.exec(stmt)[1]}`);
            const idm = /(?<![\w.])id\s+("|')/.exec(ln.masked);
            if (idm) {
                const s = ln.strings.find((x) => x.start === idm.index + idm[0].length - 1);
                if (s && (s.value === "what" || s.value === "who")) dialogue.push(`id "${s.value}"`);
            }

            const depth = depthMap(ln.masked);
            ACTION_PROPS.lastIndex = 0;
            let am;
            while ((am = ACTION_PROPS.exec(ln.masked))) {
                if (depth[am.index] !== 0) continue;
                const a = am.index + am[0].length;
                const b = exprEnd(ln.masked, a);
                const kinds = [];
                actionKinds(ln.masked, a, b, kinds);
                for (const k of kinds) actions[k] = (actions[k] || 0) + 1;
            }

            // Text interpolation reads store variables too: "[player_name]".
            for (const s of ln.strings) {
                const v = s.value.replace(/\[\[/g, "");
                const ire = /\[\s*([A-Za-z_]\w*)(?:\.(\w+))?/g;
                let im;
                while ((im = ire.exec(v))) consider(im[1], im[2]);
            }
        }

        // `tag menu` names a tag and `use navigation` a screen, not variables.
        if (!item.python && /^tag\s/.test(stmt)) continue;
        const um = !item.python && /^(\s*use\s+)(\w+)/.exec(ln.masked);
        const skipAt = um && um[2] !== "expression" ? um[1].length : -1;

        const depth = depthMap(ln.masked);
        IDENT.lastIndex = from;
        let tm;
        while ((tm = IDENT.exec(ln.masked))) {
            const name = tm[0];
            if (tm.index === skipAt) continue;
            const end = tm.index + name.length;
            const rest = ln.masked.slice(end);
            const next = (/^\s*(\S)/.exec(rest) || [, ""])[1];
            if (next === "(") continue;
            if (/^["'`]/.test(rest) && /^[rRuUbBfF]{1,2}$/.test(name)) continue;
            if (next === "=" && !/^\s*==/.test(rest)) continue;
            const attr = (/^\s*\.\s*(\w+)/.exec(rest) || [])[1];
            if (depth[tm.index] > 0 && /^\s*:/.test(rest) && /[{,]\s*$/.test(ln.masked.slice(0, tm.index))) continue;
            consider(name, attr);
        }
    }

    // A screen that reads `persistent.*` has more than one look — before and after clearing the
    // game, locked and unlocked — and a screenshot only ever catches one of them.
    const persistentReads = new Set();
    for (const item of def.body) {
        for (const m of item.ln.masked.matchAll(/persistent\.(\w+)/g)) persistentReads.add(`persistent.${m[1]}`);
    }

    return { meta, elements, actions, clickable, dialogue, customDisplayables, vars, unresolved, persistentReads };
}

/**
 * @returns {Array} screen entries, standard ones first in template order, then custom ones by
 *   first definition, then names that are only referenced.
 */
export function buildScreens(col, gameMenuScreen) {
    const byName = new Map();
    const entry = (name) => {
        if (!byName.has(name)) {
            byName.set(name, { name, category: screenCategory(name), defined: false, definitions: [], callSites: [], uses: [], usedBy: [], storeVariables: [], unresolvedNames: [], actions: {}, elements: {}, persistentReads: [], classification: null, classificationReasons: [], _a: [] });
        }
        return byName.get(name);
    };

    for (const def of col.screenDefs) {
        const e = entry(def.name);
        const a = analyzeDefinition(def, col);
        e.defined = true;
        const endLine = def.body.length ? def.body[def.body.length - 1].ln.endLine : def.endLine;
        e.definitions.push({ file: def.file, line: def.line, endLine, signature: def.signature, params: def.params, ...a.meta });
        e._a.push(a);
    }

    for (const s of col.callSites) {
        const { gameMenuDefault, screen, ...rest } = s;
        let name = screen;
        if (gameMenuDefault) {
            if (!gameMenuScreen) continue;
            name = gameMenuScreen.screen;
            rest.via = gameMenuScreen.via;
        }
        const e = entry(name);
        e.callSites.push(rest);
        if (s.kind === "use" && s.caller) {
            const caller = entry(s.caller);
            if (!caller.uses.includes(name)) caller.uses.push(name);
            if (!e.usedBy.includes(s.caller)) e.usedBy.push(s.caller);
        }
    }

    for (const e of byName.values()) {
        const vars = new Map();
        const unresolved = new Set();
        for (const a of e._a) {
            for (const [n, d] of a.vars) vars.set(n, d);
            for (const n of a.unresolved) unresolved.add(n);
            for (const [k, v] of Object.entries(a.actions)) e.actions[k] = (e.actions[k] || 0) + v;
            for (const [k, v] of Object.entries(a.elements)) e.elements[k] = (e.elements[k] || 0) + v;
        }
        e.persistentReads = [...new Set(e._a.flatMap((a) => [...(a.persistentReads ?? [])]))].sort();
        e.storeVariables = [...vars].map(([name, declaredBy]) => ({ name, declaredBy })).sort((x, y) => x.name.localeCompare(y.name));
        e.unresolvedNames = [...unresolved].sort();
        e.actions = sortObject(e.actions);
        e.elements = sortObject(e.elements);
        e.uses.sort();
        e.usedBy.sort();
        e.callSites.sort(byLocation);
    }

    classify(byName);

    const order = new Map(STANDARD_SCREENS.map((n, i) => [n, i]));
    const list = [...byName.values()].map(({ _a, ...e }) => e);
    const rank = (e) => (e.category === "standard" ? 0 : e.category === "custom" ? (e.defined ? 1 : 2) : 3);
    list.sort((a, b) => {
        const r = rank(a) - rank(b);
        if (r) return r;
        if (a.category === "standard") return order.get(a.name) - order.get(b.name);
        if (a.defined && b.defined) return byLocation(a.definitions[0], b.definitions[0]);
        return a.name.localeCompare(b.name);
    });
    return list;
}

function classify(byName) {
    const direct = new Map();
    for (const e of byName.values()) {
        const clickable = {};
        const dialogue = new Set();
        const custom = new Set();
        let modal = false;
        for (const a of e._a) {
            for (const c of a.customDisplayables) custom.add(c);
            for (const [k, v] of Object.entries(a.clickable)) clickable[k] = (clickable[k] || 0) + v;
            for (const d of a.dialogue) dialogue.add(d);
            if (a.meta.modal === true) modal = true;
        }
        direct.set(e.name, { clickable, dialogue: [...dialogue], custom: [...custom], modal });
    }
    const memo = new Map();
    const interactiveVia = (name, seen = new Set()) => {
        if (memo.has(name)) return memo.get(name);
        if (seen.has(name)) return null;
        seen.add(name);
        const d = direct.get(name);
        let res = null;
        if (d && (Object.keys(d.clickable).length || d.custom.length)) res = name;
        else {
            for (const u of byName.get(name)?.uses ?? []) {
                if (interactiveVia(u, seen)) {
                    res = u;
                    break;
                }
            }
        }
        memo.set(name, res);
        return res;
    };
    for (const e of byName.values()) {
        const d = direct.get(e.name);
        const reasons = [];
        if (!e.defined) {
            e.classification = null;
            e.classificationReasons = ["未找到定义，无法分类"];
            continue;
        }
        const parts = Object.entries(d.clickable).map(([k, v]) => `${k}×${v}`);
        if (parts.length) reasons.push(`含可点击控件：${parts.join("、")}`);
        const via = parts.length || d.custom.length ? null : interactiveVia(e.name);
        if (via) reasons.push(`引用了可交互界面 ${via}`);
        if (d.custom.length) reasons.push(`包含自定义 Python 可视组件 ${d.custom.join("、")}，可能自行处理输入`);
        if (d.dialogue.length) reasons.push(`显示台词：${d.dialogue.join("、")}`);
        if (d.modal) reasons.push("modal True");
        const interactive = parts.length > 0 || d.custom.length > 0 || !!via;
        if (!interactive && !d.dialogue.length) reasons.push("无可点击控件，仅用于显示");
        e.classification = interactive ? "interactive" : "dialogue_like";
        e.classificationReasons = reasons;
    }
}

const CONTROL_ACTIONS = { If: [1, 2] };

/** Kinds of the actions in masked[a, b): a call, a list of actions, or a conditional. */
function actionKinds(m, a, b, out) {
    while (a < b && m[a] === " ") a++;
    while (b > a && m[b - 1] === " ") b--;
    if (a >= b) return;
    if ((m[a] === "[" || m[a] === "(") && matchBracket(m, a) === b - 1) {
        for (const [x, y] of splitArgs(m, a + 1, b - 1)) actionKinds(m, x, y, out);
        return;
    }
    const depth = depthMap(m);
    const cre = /\s(if|else)\s/g;
    cre.lastIndex = a;
    const cuts = [];
    let cm;
    while ((cm = cre.exec(m)) && cm.index < b) if (depth[cm.index] === depth[a]) cuts.push(cm);
    if (cuts.length >= 2 && cuts[0][1] === "if") {
        actionKinds(m, a, cuts[0].index, out);
        actionKinds(m, cuts[1].index + cuts[1][0].length, b, out);
        return;
    }
    const call = /^([A-Za-z_][\w.]*)\s*\(/.exec(m.slice(a, b));
    if (call) {
        out.push(call[1]);
        const open = a + call[0].length - 1;
        const close = matchBracket(m, open);
        const nested = CONTROL_ACTIONS[call[1]];
        if (nested && close > 0) {
            const args = splitArgs(m, open + 1, close);
            for (const i of nested) if (args[i] && !/^\w+\s*=/.test(m.slice(...args[i]))) actionKinds(m, ...args[i], out);
        }
        return;
    }
    const t = m.slice(a, b);
    if (t !== "None") out.push(/^[A-Za-z_]\w*$/.test(t) ? "(variable)" : "(expression)");
}

function sortObject(o) {
    return Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b)));
}

export function byLocation(a, b) {
    return a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line;
}
