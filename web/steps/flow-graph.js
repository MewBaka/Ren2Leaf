// The script's logic drawn as a graph: one box per label, in the order play reaches them, with the
// menus inside the box they belong to and an arrow from each option to where it goes. It is there so
// the migrator can see the branches before deciding where a chapter or a scene starts.
//
// Layout is the plain layered kind: a label sits one row below the lowest label that leads into it,
// counting only arrows that go forward in play order. Arrows that go back (a loop, a route that
// rejoins an earlier label) are drawn dashed down the right-hand side instead of ranking anything.

import { h } from "./shared.js";
import { ENGINE_LABELS, isLocal } from "../shared/outline.js";

const TITLE = new Set(["splashscreen", "main_menu", "_main_menu", "before_main_menu"]);
const CALLS = new Set(["call", "callExpression", "Call()", "renpy.call", "renpy.call_in_new_context", "renpy.invoke_in_new_context", "renpy.call_replay", "Replay()"]);

// Box geometry. The CSS gives each part exactly these heights, so the layout can be done up front.
const W = 220;
const GAP_X = 32;
const GAP_Y = 56;
const PAD = 24;
const HEAD = 48;
const TAGS = 22;
const ROW = 24;
const STUB = 20;
const MENU_GAP = 6;
const FOOT = 6;

const SVG = "http://www.w3.org/2000/svg";
const svg = (tag, attrs = {}) => {
    const el = document.createElementNS(SVG, tag);
    for (const [k, v] of Object.entries(attrs)) if (v !== null && v !== undefined) el.setAttribute(k, v);
    return el;
};

const owner = (name) => (isLocal(name) ? name.slice(0, name.indexOf(".")) : name);
const kindOf = (k) => (k === "fallthrough" ? "fall" : CALLS.has(k) ? "call" : "jump");
const KIND_TEXT = { jump: "jump", call: "call", fall: "顺序进入", choice: "选项" };

/** Every reachable story label, with its local labels folded in, keyed by name. */
function build(data) {
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
    // An option's jump is drawn from the option itself, so the same jump is not drawn again from the
    // bottom of the box. The scan records it as a plain jump; the option's target is what tells them apart.
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

/**
 * @param {object} data   the flow slice of the inventory
 * @param {object} opts
 * @param {Set|null} opts.scope         files whose labels are drawn; null draws them all
 * @param {Function} opts.chapterOf     file -> chapter name, for arrows that leave the scope
 * @param {object} opts.state           {selected, top, left}, kept by the caller across redraws
 * @param {Function} opts.onSelect      (name, widen) when a box or a target is clicked
 */
export function flowGraph(data, { scope, chapterOf, state, onSelect }) {
    const all = build(data);
    const inScope = (n) => n && (!scope || scope.has(n.file));
    const nodes = [...all.values()].filter(inScope)
        .sort((a, b) => (a.playOrder ?? Infinity) - (b.playOrder ?? Infinity) || a.file.localeCompare(b.file) || a.line - b.line);
    if (!nodes.length) return h("div", { class: "fg-empty" }, "这里没有从入口走得到的剧情 label");

    // What each box shows: where its arrows go, and the ones that leave what is drawn.
    const where = (to) => {
        const t = all.get(to);
        if (!t) return TITLE.has(to) ? "回到标题" : null;
        const ch = chapterOf?.(t.file);
        return ch ? `${ch}` : t.file;
    };
    for (const n of nodes) {
        n.tags = [];
        if (n.ending) n.tags.push(n.ending);
        if (n.called) n.tags.push(`被 call ${n.called} 次`);
        if (n.dynamic) n.tags.push(`${n.dynamic} 处动态跳转`);
        n.lines = [];
        n.stubs = [];
        for (const e of n.edges) {
            const t = all.get(e.to);
            if (TITLE.has(e.to) && !t) {
                if (!n.tags.includes("回到标题")) n.tags.push("回到标题");
            } else if (inScope(t)) n.lines.push({ ...e, from: n.name });
            else n.stubs.push({ ...e, where: where(e.to) });
        }
        n.height = HEAD + (n.tags.length ? TAGS : 0)
            + n.menus.reduce((s, m) => s + m.choices.length * ROW, 0) + Math.max(0, n.menus.length) * MENU_GAP
            + n.stubs.length * STUB + FOOT;
    }

    // Rows: a box goes one below the lowest box that leads forward into it.
    const byName = new Map(nodes.map((n) => [n.name, n]));
    const order = new Map(nodes.map((n, i) => [n.name, i]));
    const targets = (n) => [
        ...n.lines.map((e) => e.to),
        ...n.menus.flatMap((m) => m.choices.map((c) => c.to)).filter((to) => to && byName.has(to)),
    ];
    // An arrow goes back only when it closes a loop: its target is still being walked from. Two
    // routes meeting again (both endings of a choice jumping to the same label) are not a loop.
    const back = new Set();
    const seen = new Map();
    const finished = [];
    const walk = (name) => {
        seen.set(name, 1);
        for (const to of targets(byName.get(name))) {
            if (seen.get(to) === 1) back.add(`${name}\n${to}`);
            else if (!seen.has(to)) walk(to);
        }
        seen.set(name, 2);
        finished.push(name);
    };
    for (const n of nodes) if (!seen.has(n.name)) walk(n.name);
    const forward = (from, to) => !back.has(`${from}\n${to}`);
    const rank = new Map(nodes.map((n) => [n.name, 0]));
    const preds = new Map(nodes.map((n) => [n.name, []]));
    for (const name of finished.reverse()) {
        for (const to of targets(byName.get(name))) {
            if (!forward(name, to)) continue;
            rank.set(to, Math.max(rank.get(to), rank.get(name) + 1));
            preds.get(to).push(name);
        }
    }
    const rows = [];
    for (const n of nodes) (rows[rank.get(n.name)] ??= []).push(n);

    // Columns: under the boxes that lead in, pushed right only as far as the row needs.
    const x = new Map();
    let y = PAD;
    for (const row of rows) {
        if (!row) continue;
        const want = (n) => {
            const p = preds.get(n.name).filter((name) => x.has(name));
            return p.length ? p.reduce((s, name) => s + x.get(name), 0) / p.length : PAD;
        };
        const placed = row.map((n) => ({ n, want: want(n) })).sort((a, b) => a.want - b.want || order.get(a.n.name) - order.get(b.n.name));
        let right = -Infinity;
        for (const p of placed) {
            const at = Math.max(p.want, right + GAP_X);
            x.set(p.n.name, at);
            p.n.x = at;
            p.n.y = y;
            right = at + W;
        }
        y += Math.max(...row.map((n) => n.height)) + GAP_Y;
    }
    const minX = Math.min(...nodes.map((n) => n.x));
    for (const n of nodes) n.x += PAD - minX;
    const width = Math.max(...nodes.map((n) => n.x + W)) + PAD + 120;
    const height = y - GAP_Y + PAD;

    // Arrows.
    const paper = svg("svg", { class: "fg-edges", width, height, viewBox: `0 0 ${width} ${height}` });
    const defs = svg("defs");
    for (const k of ["jump", "call", "fall", "choice", "back"]) {
        const marker = svg("marker", { id: `fg-arrow-${k}`, viewBox: "0 0 8 8", refX: 7, refY: 4, markerWidth: 7, markerHeight: 7, orient: "auto-start-reverse" });
        marker.append(svg("path", { d: "M0,0 L8,4 L0,8 z", class: `fg-head is-${k}` }));
        defs.append(marker);
    }
    paper.append(defs);
    const edge = (from, to, kind, x1, y1, fromRow) => {
        const t = byName.get(to);
        const back = !forward(from, to);
        let d;
        if (back) {
            const x2 = t.x + W;
            const y2 = t.y + HEAD / 2;
            const sx = fromRow ? x1 : byName.get(from).x + W;
            const sy = fromRow ? y1 : byName.get(from).y + byName.get(from).height / 2;
            const bulge = Math.max(sx, x2) + 60;
            d = `M${sx},${sy} C${bulge},${sy} ${bulge},${y2} ${x2},${y2}`;
        } else {
            const x2 = t.x + W / 2;
            const y2 = t.y;
            const dy = Math.max(GAP_Y, y2 - y1) / 2;
            d = fromRow
                ? `M${x1},${y1} C${x1 + 20},${y1 + 10} ${x2},${y2 - dy} ${x2},${y2}`
                : `M${x1},${y1} C${x1},${y1 + dy} ${x2},${y2 - dy} ${x2},${y2}`;
        }
        const cls = back ? "back" : kind;
        paper.append(svg("path", { d, class: `fg-edge is-${cls}`, "data-from": from, "data-to": to, "marker-end": `url(#fg-arrow-${cls})` }));
    };

    const box = h("div", { class: "fg-canvas", style: { width: `${width}px`, height: `${height}px` } }, paper);
    const target = (to, stay) => {
        const t = all.get(to);
        return h("button", {
            type: "button", class: "fg-to", title: t ? `${t.file}:${t.line}` : to,
            onclick: (e) => {
                e.stopPropagation();
                if (t) onSelect(to, !stay);
            },
        }, to);
    };
    for (const n of nodes) {
        const el = h("div", {
            class: `fg-node${state.selected === n.name ? " is-selected" : ""}${n.ending ? " is-ending" : ""}${n.name === "start" ? " is-start" : ""}`,
            "data-name": n.name,
            style: { left: `${n.x}px`, top: `${n.y}px`, width: `${W}px`, height: `${n.height}px` },
            onclick: () => onSelect(state.selected === n.name ? null : n.name, false),
        },
        h("div", { class: "fg-head" },
            h("span", { class: "fg-name mono" }, n.name),
            h("span", { class: "fg-says" }, n.says ? `${n.says} 句` : "无台词")),
        h("div", { class: "fg-at mono" }, `${n.file}:${n.line}`),
        n.tags.length ? h("div", { class: "fg-tags" }, n.tags.map((t) => h("span", { class: `fg-tag${t === "结局" || t === "回到标题" ? " is-end" : ""}` }, t))) : null);
        let rowY = n.y + HEAD + (n.tags.length ? TAGS : 0);
        for (const m of n.menus) {
            rowY += MENU_GAP;
            const menu = h("div", { class: "fg-menu", title: `菜单 ${m.file}:${m.line}` });
            for (const c of m.choices) {
                const t = c.to ? all.get(c.to) : null;
                const drawn = t && inScope(t);
                menu.append(h("div", { class: "fg-choice", title: c.condition ? `${c.text}（条件 ${c.condition}）` : c.text },
                    h("span", { class: "fg-choice-text" }, c.condition ? "◆ " : "◇ ", c.text),
                    c.to
                        ? TITLE.has(c.to) && !t ? h("span", { class: "fg-choice-to" }, "回到标题")
                            : drawn ? h("span", { class: "fg-choice-to" }, "→")
                                : h("span", { class: "fg-choice-to" }, target(c.to), t ? ` ${where(c.to)}` : "")
                        : h("span", { class: "fg-choice-to is-dim" }, "继续")));
                if (drawn) edge(n.name, c.to, "choice", n.x + W, rowY + ROW / 2, true);
                rowY += ROW;
            }
            el.append(menu);
        }
        for (const s of n.stubs) {
            el.append(h("div", { class: "fg-stub" },
                h("span", {}, `${KIND_TEXT[s.kind]} → `), target(s.to), s.where ? h("span", { class: "fg-dim" }, ` ${s.where}`) : null));
        }
        for (const e of n.lines) edge(n.name, e.to, e.kind, n.x + W / 2, n.y + n.height, false);
        // Hovering a box lights up what goes in and out of it.
        el.addEventListener("mouseenter", () => light(n.name, true));
        el.addEventListener("mouseleave", () => light(n.name, false));
        box.append(el);
    }
    function light(name, on) {
        for (const p of paper.querySelectorAll(`[data-from="${CSS.escape(name)}"], [data-to="${CSS.escape(name)}"]`)) p.classList.toggle("is-hot", on);
    }
    if (state.selected) light(state.selected, true);

    const scroller = h("div", { class: "fg-scroll" }, box);
    scroller.addEventListener("scroll", () => {
        state.top = scroller.scrollTop;
        state.left = scroller.scrollLeft;
    });
    requestAnimationFrame(() => {
        const sel = state.selected ? byName.get(state.selected) : null;
        if (sel && state.reveal) {
            state.reveal = false;
            scroller.scrollTop = Math.max(0, sel.y - 80);
            scroller.scrollLeft = Math.max(0, sel.x - 80);
        } else {
            scroller.scrollTop = state.top ?? 0;
            scroller.scrollLeft = state.left ?? 0;
        }
    });

    const legend = h("div", { class: "fg-legend" },
        ...[["jump", "jump"], ["choice", "选项"], ["fall", "顺序进入下一个 label"], ["call", "call（跑完回到调用处）"], ["back", "回到前面的 label"]]
            .map(([k, text]) => h("span", { class: "fg-key" }, h("span", { class: `fg-swatch is-${k}` }), text)),
        h("span", { class: "fg-key" }, "◆ 有条件的选项"));

    const parts = [legend, scroller];
    const sel = state.selected ? all.get(state.selected) : null;
    if (sel?.raw) {
        const l = sel.raw;
        const incoming = l.in.map((e) => `${KIND_TEXT[kindOf(e.kind)] ?? e.kind} ← ${e.from ?? e.screen ?? "入口"}`);
        parts.push(h("div", { class: "fg-detail" },
            h("span", { class: "mono" }, `${l.file}:${l.line}–${l.endLine}`),
            h("span", {}, sel.says ? `${sel.says} 句台词` : "无台词"),
            h("span", {}, incoming.length ? `入口：${[...new Set(incoming)].join("；")}` : "入口：游戏开始")));
    }
    return h("div", { class: "fg" }, parts);
}
