// The script's logic as labels and where each one goes: jumps, calls, falling through into the next
// label, and the options of its menus. The flow step draws it as a graph and the exported package
// lists it as a table, so both say the same thing. Imported by the browser and by the server alike.

import { ENGINE_LABELS, isLocal } from "./outline.js";

/** Jumping to one of these is going back to the title screen, which ends a route. */
export const TITLE_LABELS = new Set(["splashscreen", "main_menu", "_main_menu", "before_main_menu"]);
const CALLS = new Set(["call", "callExpression", "Call()", "renpy.call", "renpy.call_in_new_context", "renpy.invoke_in_new_context", "renpy.call_replay", "Replay()"]);

export const owner = (name) => (isLocal(name) ? name.slice(0, name.indexOf(".")) : name);
export const kindOf = (k) => (k === "fallthrough" ? "fall" : CALLS.has(k) ? "call" : "jump");
export const KIND_TEXT = { jump: "jump", call: "call", fall: "顺序进入", choice: "选项" };

/** Every reachable story label, with its local labels folded in, keyed by name. */
export function labelGraph(data) {
    const nodes = new Map();
    for (const l of data.labels) {
        if (!l.reachable) continue;
        const name = owner(l.name);
        if (ENGINE_LABELS.has(name)) continue;
        let n = nodes.get(name);
        if (!n) {
            n = { name, file: l.file, line: l.line, says: 0, playOrder: l.playOrder, edges: [], menus: [], dynamic: 0, ending: null, called: 0, raw: null };
            nodes.set(name, n);
        }
        if (l.name === name) {
            Object.assign(n, { file: l.file, line: l.line, raw: l });
            n.called = l.in.filter((e) => CALLS.has(e.kind)).length;
        }
        n.says += l.says;
        if (l.playOrder !== null && (n.playOrder === null || l.playOrder < n.playOrder)) n.playOrder = l.playOrder;
        for (const e of l.out) {
            if (!e.to) {
                n.dynamic++;
                continue;
            }
            const to = owner(e.to);
            if (to === name) continue;
            const kind = kindOf(e.kind);
            if (!n.edges.some((x) => x.to === to && x.kind === kind)) n.edges.push({ to, kind });
        }
    }
    for (const m of data.menus) {
        const n = m.label ? nodes.get(owner(m.label)) : null;
        if (!n) continue;
        n.menus.push({
            file: m.file, line: m.line,
            choices: m.choices.map((c) => ({ text: c.text, condition: c.condition, to: c.target ? owner(c.target) : null })),
        });
    }
    // An option's jump belongs to the option, so it is not listed again as the label's own. The scan
    // records it as a plain jump; the option's target is what tells them apart.
    for (const n of nodes.values()) {
        const chosen = new Set(n.menus.flatMap((m) => m.choices.map((c) => c.to)).filter(Boolean));
        n.edges = n.edges.filter((e) => e.kind !== "jump" || !chosen.has(e.to));
    }
    for (const e of data.endings) {
        const n = nodes.get(owner(e.name));
        if (n) n.ending = e.kind === "toTitle" || e.kind === "restart" ? "回到标题" : "结局";
    }
    return nodes;
}
