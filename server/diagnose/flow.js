// Step ⑤ flow and chapters: the label graph (jump, call, menu, fall-through), what the player can
// actually reach, where the routes end, and what each script file holds.
//
// Chapters are not decided here. The migrator groups the files; this file only supplies what that
// decision needs: play order (a Ren'Py file number is not it — branch endings are often numbered
// low), how much dialogue each file holds, and the signals that often mark a break (a black screen
// with `stop music`, an OP/ED movie, an achievement).

import { byLocation } from "./screens.js";

export const LABEL_LIMIT = 2000;

/** Labels the engine enters by itself. */
const ENGINE_LABELS = new Set([
    "start", "splashscreen", "before_main_menu", "main_menu", "after_load", "after_warp",
    "quit", "hide_windows", "_start", "_main_menu", "_quit", "autosave", "replay",
]);
/**
 * The engine labels that are not story: they always end in `return` and that return is not a route
 * ending. `start` is left out of this set on purpose — when the main route is written as
 * `call c1_c2` / `call c3` inside `start`, the end of `start` is where that route ends.
 */
const MENU_LABELS = new Set([...ENGINE_LABELS].filter((n) => n !== "start"));

/** Edge kinds that come back: the called label's `return` goes to the line after the call. */
const CALL_KINDS = new Set(["call", "callExpression", "Call()", "renpy.call", "renpy.call_in_new_context", "renpy.invoke_in_new_context", "renpy.call_replay", "Replay()"]);
const isCall = (kind) => CALL_KINDS.has(kind);

const BREAK_SCORE = { opEd: 10, movie: 6, achievement: 4, stopMusic: 3, blackout: 2, music: 1 };
const PAIR_WINDOW = 6;      // lines within which two signals count as one cut
const PAIR_SCORE = 8;       // a blackout together with `stop music`
const SWAP_SCORE = 5;       // `stop music` followed by different music
const CUT_SCORE = 6;        // a signal strong enough to be worth showing as a possible break

function labelRegions(col) {
    const byFile = new Map();
    for (const l of col.labels) {
        if (!byFile.has(l.file)) byFile.set(l.file, []);
        byFile.get(l.file).push(l);
    }
    const regions = [];
    for (const [file, list] of byFile) {
        list.sort((a, b) => a.line - b.line);
        list.forEach((l, i) => {
            const next = list[i + 1];
            regions.push({
                ...l,
                endLine: next ? next.line - 1 : (col.fileEnd.get(file) ?? l.line),
                nextInFile: next ? next.name : null,
            });
        });
    }
    return regions.sort(byLocation);
}

/**
 * Does the label's own block end with a jump or a return? If not, play falls through into the next
 * label in the file. Judged from the last flow statement at the block's own indent, which is where
 * a terminal `jump`/`return` is written.
 */
function terminalOf(label, outgoing, returns) {
    const stmts = [
        ...outgoing.filter((e) => e.kind === "jump" || e.kind === "jumpExpression").map((e) => ({ line: e.line, indent: e.indent, kind: "jump" })),
        ...returns.map((r) => ({ line: r.line, indent: r.indent, kind: "return" })),
    ].sort((a, b) => a.line - b.line);
    if (!stmts.length) return null;
    const base = Math.min(...stmts.map((s) => s.indent ?? 0));
    const last = stmts[stmts.length - 1];
    return (last.indent ?? 0) === base ? last.kind : null;
}

function graph(col, regions) {
    const byName = new Map();
    for (const l of regions) if (!byName.has(l.name)) byName.set(l.name, l);

    const nodes = new Map();
    for (const l of regions) {
        if (nodes.has(l.name)) continue;
        nodes.set(l.name, {
            name: l.name, file: l.file, line: l.line, endLine: l.endLine,
            global: l.global, local: l.name.includes("."), parameters: l.parameters ?? null,
            says: 0, menus: 0, out: [], in: [], terminal: null, fallsThroughTo: null,
            reachable: false, playOrder: null, entryRoot: null, newGamePlus: false, calledFrom: 0,
        });
    }

    const entryEdges = [];
    for (const e of col.edges) {
        const node = e.from ? nodes.get(e.from) : null;
        const target = e.to ? nodes.get(e.to) : null;
        const rec = { kind: e.kind, to: e.to, expr: e.expr, file: e.file, line: e.line, indent: e.indent, screen: e.screen, choiceText: e.choiceText ?? null };
        rec.persistentGuard = !!e.persistentGuard;
        rec.guards = e.guards ?? null;
        if (node) node.out.push(rec);
        else entryEdges.push(rec);
        if (target && e.to) {
            target.in.push({ kind: e.kind, from: e.from, file: e.file, line: e.line, screen: e.screen });
            if (isCall(e.kind)) target.calledFrom++;
        }
    }

    for (const [name, node] of nodes) {
        const region = byName.get(name);
        const returns = col.returns.filter((r) => r.label === name);
        node.terminal = terminalOf(node, node.out, returns);
        node.returns = returns.length;
        if (!node.terminal && region?.nextInFile) {
            node.fallsThroughTo = region.nextInFile;
            node.out.push({ kind: "fallthrough", to: region.nextInFile, expr: null, file: node.file, line: node.endLine, indent: node.indent ?? 0, screen: null, choiceText: null });
        }
    }
    return { nodes, entryEdges };
}

/** First-visit order from the engine's entry labels, following each label's statements in order. */
function playOrder(nodes, entryEdges) {
    const entries = [];
    for (const name of ["start", "splashscreen", "main_menu", "after_load"]) {
        if (nodes.has(name)) entries.push(name);
    }
    for (const e of entryEdges) if (e.to && nodes.has(e.to) && !entries.includes(e.to)) entries.push(e.to);
    for (const name of ENGINE_LABELS) if (nodes.has(name) && !entries.includes(name)) entries.push(name);

    const order = [];
    const seen = new Set();
    let root = null;
    let guarded = false;
    const visit = (name) => {
        if (seen.has(name)) return;
        const node = nodes.get(name);
        if (!node) return;
        seen.add(name);
        node.reachable = true;
        node.entryRoot = root;
        node.playOrder = order.length;
        node.newGamePlus = guarded;
        order.push(name);
        const next = [...node.out].sort((a, b) => a.line - b.line);
        for (const e of next) if (e.to && !(e.persistentGuard && !guarded)) visit(e.to);
    };
    // First pass: what a fresh save reaches. A jump under `if persistent.x` is skipped, because
    // the flag is False until something earlier in the game sets it.
    for (const name of entries) {
        root = name;
        visit(name);
    }
    // Second pass: the routes that open up on a later playthrough. It carries on from the labels
    // the first pass stopped at, because the guarded jump usually sits in `start` itself.
    guarded = true;
    for (const name of [...order]) {
        const node = nodes.get(name);
        root = node.entryRoot;
        for (const e of [...node.out].sort((a, b) => a.line - b.line)) if (e.to) visit(e.to);
    }
    for (const name of entries) {
        root = name;
        visit(name);
    }
    // Anything still unvisited is unreachable; keep it out of the play order.
    return { order, entries };
}

function scoreBreaks(beats) {
    const sorted = [...beats].sort((a, b) => a.line - b.line);
    const out = [];
    for (const b of sorted) {
        const score = BREAK_SCORE[b.kind] ?? 1;
        const row = { kind: b.kind, file: b.file, line: b.line, label: b.label, evidence: b.evidence, snippet: b.snippet, score, reasons: [] };
        if (b.kind === "blackout" || b.kind === "stopMusic") {
            const other = b.kind === "blackout" ? "stopMusic" : "blackout";
            const near = sorted.find((x) => x.kind === other && Math.abs(x.line - b.line) <= PAIR_WINDOW && x.file === b.file);
            if (near) {
                row.score = PAIR_SCORE;
                row.reasons.push("黑场与 stop music 相邻出现");
            }
        }
        if (b.kind === "stopMusic" && row.score < PAIR_SCORE) {
            const swap = sorted.find((x) => x.kind === "music" && x.file === b.file && x.line > b.line && x.line - b.line <= PAIR_WINDOW);
            if (swap) {
                row.score = SWAP_SCORE;
                row.reasons.push("停止音乐后切换了其他曲目");
            }
        }
        if (b.kind === "opEd") row.reasons.push("OP/ED 视频");
        else if (b.kind === "movie") row.reasons.push("过场视频");
        else if (b.kind === "achievement") row.reasons.push("成就点");
        else if (!row.reasons.length) row.reasons.push(b.kind === "blackout" ? "黑场" : b.kind === "stopMusic" ? "停止音乐" : "换音乐");
        out.push(row);
    }
    // Two cuts on the same spot (fade + stop music + movie) are one cut.
    const merged = [];
    for (const row of out) {
        const prev = merged[merged.length - 1];
        if (prev && prev.file === row.file && row.line - prev.line <= PAIR_WINDOW) {
            if (row.score > prev.score) {
                prev.kind = row.kind;
                prev.evidence = row.evidence;
                prev.snippet = row.snippet;
            }
            prev.score = Math.max(prev.score, row.score);
            for (const r of row.reasons) if (!prev.reasons.includes(r)) prev.reasons.push(r);
            continue;
        }
        merged.push(row);
    }
    return merged;
}

/** What each script file holds, so the migrator can group files into chapters themselves. */
function fileFacts(col, nodes, breaks) {
    const files = new Map();
    const row = (file) => {
        if (!files.has(file)) {
            files.set(file, { file, lines: col.fileEnd.get(file) ?? 0, says: 0, labels: [], menus: 0, choices: 0, endings: 0, breaks: [], playOrder: null, newGamePlus: false });
        }
        return files.get(file);
    };
    for (const name of nodes.keys()) {
        const n = nodes.get(name);
        if (n.file.startsWith("tl/")) continue;
        const r = row(n.file);
        r.labels.push({ name, line: n.line, says: n.says, reachable: n.reachable, playOrder: n.playOrder, newGamePlus: n.newGamePlus });
        r.says += n.says;
        r.menus += n.menus;
        if (n.reachable && n.newGamePlus) r.newGamePlus = true;
        if (n.playOrder !== null && (r.playOrder === null || n.playOrder < r.playOrder)) r.playOrder = n.playOrder;
    }
    for (const m of col.menus) if (files.has(m.file)) files.get(m.file).choices += m.choices.length;
    for (const b of breaks) if (files.has(b.file)) files.get(b.file).breaks.push({ kind: b.kind, line: b.line, score: b.score, reasons: b.reasons });
    for (const r of files.values()) {
        r.labels.sort((a, b) => a.line - b.line);
        // A file is only a later-playthrough file when nothing in it is reached on a first play.
        if (r.newGamePlus && r.labels.some((l) => l.reachable && !l.newGamePlus)) r.newGamePlus = false;
    }
    // Files the player reaches first come first; files nothing reaches go last, by name.
    return [...files.values()].sort((a, b) =>
        (a.playOrder === null) - (b.playOrder === null) || (a.playOrder ?? 0) - (b.playOrder ?? 0) || a.file.localeCompare(b.file));
}

/**
 * What each menu option writes before play goes on. A route is usually chosen by an option setting
 * a flag, so an option with no jump is not the same as an option that does nothing.
 */
function choiceWrites(col, menus, nodes) {
    const assigns = new Map();
    for (const e of col.pyEntries) {
        if (e.kind !== "assign" || e.nested) continue;
        if (!assigns.has(e.file)) assigns.set(e.file, []);
        assigns.get(e.file).push(e);
    }
    for (const list of assigns.values()) list.sort((a, b) => a.line - b.line);
    const menuLines = new Map();
    for (const m of menus) {
        if (!menuLines.has(m.file)) menuLines.set(m.file, []);
        menuLines.get(m.file).push(m.line);
    }
    for (const list of menuLines.values()) list.sort((a, b) => a - b);

    for (const m of menus) {
        const rows = assigns.get(m.file) ?? [];
        const nextMenu = (menuLines.get(m.file) ?? []).find((l) => l > m.line) ?? Infinity;
        const labelEnd = m.label && nodes.has(m.label) ? nodes.get(m.label).endLine : Infinity;
        const bound = Math.min(nextMenu, labelEnd);
        const lines = m.choices.map((c) => c.line).sort((a, b) => a - b);
        for (const c of m.choices) {
            const next = lines.find((l) => l > c.line) ?? bound;
            c.sets = rows.filter((e) => e.line > c.line && e.line < next)
                .slice(0, 4)
                .map((e) => ({ line: e.line, snippet: e.snippet, variable: e.variable ?? e.target ?? null }));
        }
    }
}

/** Builds the flow section. */
export function buildFlow(col) {
    const regions = labelRegions(col);
    const { nodes, entryEdges } = graph(col, regions);

    const saysByLabel = new Map();
    for (const s of col.says) {
        if (!s.label) continue;
        saysByLabel.set(s.label, (saysByLabel.get(s.label) || 0) + 1);
    }
    for (const [name, n] of saysByLabel) if (nodes.has(name)) nodes.get(name).says = n;
    for (const m of col.menus) if (m.label && nodes.has(m.label)) nodes.get(m.label).menus++;

    const { order, entries } = playOrder(nodes, entryEdges);
    const breaks = scoreBreaks(col.beats);
    const files = fileFacts(col, nodes, breaks);

    const labels = [...nodes.values()];
    const defined = new Set(nodes.keys());
    const undefinedTargets = [];
    const dynamicTargets = [];
    for (const e of col.edges) {
        if (!e.to) dynamicTargets.push({ kind: e.kind, expr: e.expr, file: e.file, line: e.line, label: e.from, screen: e.screen });
        else if (!defined.has(e.to)) undefinedTargets.push({ kind: e.kind, target: e.to, file: e.file, line: e.line, label: e.from, screen: e.screen });
    }

    const unreachable = labels
        .filter((l) => !l.reachable && !ENGINE_LABELS.has(l.name) && !l.file.startsWith("tl/"))
        .map((l) => ({
            name: l.name, file: l.file, line: l.line, says: l.says, incoming: l.in.length,
            reason: l.in.length ? "只被动态目标或界面动作引用" : "无任何跳转指向该 label",
        }))
        .sort(byLocation);

    // A label the game `call`s is a subroutine: its `return` goes back to the caller and play
    // carries on there, so it is not where a route ends.
    const subroutines = labels
        .filter((l) => l.calledFrom)
        .map((l) => ({
            name: l.name, file: l.file, line: l.line, says: l.says, calledFrom: l.calledFrom,
            callers: l.in.filter((e) => isCall(e.kind)).slice(0, 5).map((e) => `${e.file}:${e.line}`),
        }))
        .sort(byLocation);
    const calledInto = new Set(subroutines.map((s) => s.name));

    const endings = labels
        .filter((l) => l.reachable && l.terminal === "return" && !l.out.some((e) => e.kind === "jump" || e.kind === "fallthrough"))
        // Ren'Py enters these by itself and they always end in `return`; and a called label's
        // `return` is a return to the caller.
        .filter((l) => !MENU_LABELS.has(l.name) && !calledInto.has(l.name))
        .map((l) => ({
            name: l.name, file: l.file, line: l.endLine, says: l.says,
            newGamePlus: l.newGamePlus,
            kind: l.name === "start" ? "startEnd" : /ending|_end$|end$|bad|good|true|normal/i.test(l.name) ? "namedEnding" : "return",
        }))
        .sort(byLocation);

    const notEndings = labels
        .filter((l) => l.reachable && l.terminal === "return" && (MENU_LABELS.has(l.name) || calledInto.has(l.name)))
        .map((l) => ({
            name: l.name, file: l.file, line: l.endLine, says: l.says,
            reason: calledInto.has(l.name) ? `被 call 调用 ${l.calledFrom} 次，return 返回调用方` : "Ren'Py 引擎保留 label",
        }))
        .sort(byLocation);

    choiceWrites(col, col.menus, nodes);
    const menus = col.menus.map((m) => ({
        file: m.file, line: m.line, label: m.label, screen: m.screen, caption: m.caption,
        choices: m.choices.map((c) => ({ text: c.text, condition: c.condition, arguments: c.arguments, line: c.line, target: c.target, sets: c.sets ?? [] })),
    })).sort(byLocation);

    // File order against play order: the first place they disagree is worth showing.
    const fileOrder = [...labels].filter((l) => l.reachable).sort(byLocation).map((l) => l.name);
    const playOrderNames = order.filter((n) => nodes.get(n)?.reachable);
    let divergesAt = null;
    for (let i = 0; i < Math.min(fileOrder.length, playOrderNames.length); i++) {
        if (fileOrder[i] !== playOrderNames[i]) {
            divergesAt = { index: i, byFile: fileOrder[i], byPlay: playOrderNames[i] };
            break;
        }
    }

    const warnings = [];
    if (divergesAt) {
        warnings.push({
            kind: "playOrderDiffersFromFileOrder",
            message: `文件顺序与执行顺序从第 ${divergesAt.index + 1} 个 label 起产生分歧（按文件为 ${divergesAt.byFile}，按执行为 ${divergesAt.byPlay}）`,
        });
    }
    if (unreachable.length) {
        warnings.push({ kind: "unreachableLabels", message: `${unreachable.length} 个 label 从入口不可达，可能是废弃内容、调试入口，或仅被动态跳转引用` });
    }
    if (dynamicTargets.length) {
        warnings.push({ kind: "dynamicJumps", message: `${dynamicTargets.length} 处跳转目标为运行时表达式，流程图中缺少对应边` });
    }
    if (undefinedTargets.length) {
        warnings.push({ kind: "undefinedTargets", message: `${undefinedTargets.length} 处跳转至源码中不存在的 label，可能位于 .rpyc 或 .rpa 中` });
    }
    const laterLabels = labels.filter((l) => l.reachable && l.newGamePlus);
    if (laterLabels.length) {
        warnings.push({
            kind: "newGamePlusRoutes",
            message: `${laterLabels.length} 个 label 只在 persistent 标记打开后才走得到（${laterLabels.slice(0, 6).map((l) => l.name).join("、")}${laterLabels.length > 6 ? "…" : ""}），游玩顺序把它们排在一周目路线之后`,
        });
    }
    if (notEndings.length) {
        warnings.push({
            kind: "returnsThatAreNotEndings",
            message: `${notEndings.length} 个以 return 结束的 label 并非结局（为被 call 的子流程或 Ren'Py 保留 label）`,
        });
    }
    warnings.push({
        kind: "chapterIsYours",
        message: "章节划分由迁移者决定：扫描仅提供每个文件的台词数、label 及疑似分界信号（黑场、停止音乐、过场视频、成就点）",
    });

    return {
        version: 1,
        summary: {
            labels: labels.length,
            globalLabels: labels.filter((l) => !l.local).length,
            reachable: labels.filter((l) => l.reachable).length,
            unreachable: unreachable.length,
            edges: col.edges.length,
            jumps: col.edges.filter((e) => e.kind === "jump").length,
            calls: col.edges.filter((e) => e.kind === "call").length,
            menus: menus.length,
            choices: menus.reduce((n, m) => n + m.choices.length, 0),
            returns: col.returns.length,
            endings: endings.length,
            subroutines: subroutines.length,
            newGamePlusLabels: laterLabels.length,
            files: files.length,
            breaks: breaks.filter((b) => b.score >= CUT_SCORE).length,
            sayLines: col.says.length,
            dynamicTargets: dynamicTargets.length,
            undefinedTargets: undefinedTargets.length,
            truncated: labels.length > LABEL_LIMIT,
        },
        entries,
        files,
        labels: labels.sort((a, b) => (a.playOrder ?? Infinity) - (b.playOrder ?? Infinity) || byLocation(a, b)).slice(0, LABEL_LIMIT),
        menus,
        endings,
        notEndings,
        subroutines,
        unreachable,
        dynamicTargets,
        undefinedTargets,
        breaks,
        warnings,
    };
}
