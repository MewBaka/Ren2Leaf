// "清理缓存": what a game's work directory is holding, and a sweep of the parts chosen here.
//
// Loaded on demand from the game switcher. The groups come from the server (server/cache.js), so
// this file only draws them; the one thing it decides is that nothing is ticked for you except the
// run leftovers, and that a group the server marks `precious` asks a second time before it goes.

import { api, confirm, openModal } from "./app.js";

const DEFAULT_ON = new Set(["runs"]);

function h(tag, attrs = {}, ...children) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
        if (v === undefined || v === null || v === false) continue;
        if (k === "class") el.className = v;
        else if (k === "html") el.innerHTML = v;
        else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
        else el.setAttribute(k, v === true ? "" : v);
    }
    for (const c of children.flat()) {
        if (c === null || c === undefined || c === false) continue;
        el.append(c instanceof Node ? c : document.createTextNode(String(c)));
    }
    return el;
}

export function formatBytes(n) {
    if (!n) return "空";
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
    return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

/**
 * Opens the dialog for one game. Resolves true when something was deleted, so the caller can
 * remount the step it is showing — a cleared scan or screenshot set changes what every step reads.
 */
export async function openCacheDialog(game) {
    const body = h("div", { class: "cache" });
    const modal = openModal({
        title: "清理缓存",
        body,
        width: 560,
        footer: [
            { label: "完成", variant: "secondary" },
            { id: "clear", label: "清理", variant: "danger", onClick: () => sweep() },
        ],
    });
    const clearBtn = modal.buttons.clear;
    clearBtn.disabled = true;

    const picked = new Set(DEFAULT_ON);
    let info = null;
    let orphans = null;
    let withOrphans = false;
    let changed = false;
    let busy = false;

    function row(group) {
        const box = h("input", { type: "checkbox", checked: picked.has(group.id) || null, disabled: !group.bytes || null });
        box.addEventListener("change", () => {
            if (box.checked) picked.add(group.id);
            else picked.delete(group.id);
            syncFooter();
            label.classList.toggle("is-on", box.checked);
        });
        const label = h("label", { class: `cache-row${group.precious ? " is-precious" : ""}${box.checked ? " is-on" : ""}` },
            box,
            h("span", { class: "cache-row-text" },
                h("span", { class: "cache-row-head" },
                    h("span", { class: "cache-row-label" }, group.label),
                    h("span", { class: "cache-row-size" }, group.bytes ? formatBytes(group.bytes) : "空")),
                h("span", { class: "cache-row-hint" }, group.hint)));
        return label;
    }

    function orphanRow() {
        if (!orphans?.orphans?.length) return null;
        const box = h("input", { type: "checkbox", checked: withOrphans || null });
        box.addEventListener("change", () => {
            withOrphans = box.checked;
            syncFooter();
            label.classList.toggle("is-on", box.checked);
        });
        const label = h("label", { class: `cache-row${withOrphans ? " is-on" : ""}` },
            box,
            h("span", { class: "cache-row-text" },
                h("span", { class: "cache-row-head" },
                    h("span", { class: "cache-row-label" }, "已移除游戏的残留文件"),
                    h("span", { class: "cache-row-size" }, formatBytes(orphans.bytes))),
                h("span", { class: "cache-row-hint" }, `${orphans.orphans.length} 个工作目录不属于当前列表中的任何游戏，重新添加该游戏也不会复用`)));
        return label;
    }

    function selectedBytes() {
        let n = 0;
        for (const g of info?.groups || []) if (picked.has(g.id)) n += g.bytes;
        if (withOrphans) n += orphans?.bytes || 0;
        return n;
    }

    function syncFooter() {
        const bytes = selectedBytes();
        const any = (info?.groups || []).some((g) => picked.has(g.id) && g.bytes) || (withOrphans && orphans?.bytes);
        clearBtn.disabled = busy || !any;
        clearBtn.textContent = busy ? "清理中…" : bytes ? `清理 ${formatBytes(bytes)}` : "清理";
    }

    function render(note) {
        body.replaceChildren();
        if (!info) {
            body.append(h("p", { class: "cache-note" }, "正在统计…"));
            return;
        }
        body.append(h("div", { class: "cache-total" },
            h("span", {}, `工作目录共 ${formatBytes(info.bytes)}`),
            h("span", { class: "cache-path mono", "data-tip": info.workDir }, info.workDir.replace(/^\/Users\/[^/]+/, "~"))));
        if (info.running) {
            body.append(h("p", { class: "cache-warn" }, "游戏正在运行，请先结束当前会话再执行清理"));
        }
        const list = h("div", { class: "cache-list" });
        for (const group of info.groups) {
            if (group.precious) continue;
            list.append(row(group));
        }
        const orphan = orphanRow();
        if (orphan) list.append(orphan);
        body.append(list);
        const precious = info.groups.filter((g) => g.precious && g.bytes);
        if (precious.length) {
            body.append(h("div", { class: "cache-sep" }, "以下内容不属于缓存"));
            const danger = h("div", { class: "cache-list" });
            for (const group of precious) danger.append(row(group));
            body.append(danger);
        }
        if (note) body.append(h("p", { class: "cache-note" }, note));
        syncFooter();
    }

    async function load(note) {
        try {
            const [cache, orphanInfo] = await Promise.all([
                api.get(`/api/games/${game.id}/cache`),
                api.get("/api/cache/orphans"),
            ]);
            info = cache;
            orphans = orphanInfo;
            withOrphans = withOrphans && Boolean(orphans.orphans.length);
            for (const g of info.groups) if (!g.bytes) picked.delete(g.id);
        } catch (err) {
            body.replaceChildren(h("p", { class: "cache-warn" }, err.message));
            clearBtn.disabled = true;
            return;
        }
        render(note);
    }

    async function sweep() {
        const groups = [...picked].filter((id) => info.groups.some((g) => g.id === id && g.bytes));
        const precious = info.groups.filter((g) => g.precious && groups.includes(g.id));
        if (precious.length) {
            const ok = await confirm({
                title: "是否同时删除已填写的配置？",
                message: `${precious.map((g) => g.label).join("、")} 为手动填写的内容，删除后需重新配置。`,
                confirmText: "删除",
                tone: "danger",
            });
            if (!ok) return;
        }
        busy = true;
        syncFooter();
        let freed = 0;
        try {
            if (groups.length) {
                const res = await api.post(`/api/games/${game.id}/cache/clear`, { groups });
                freed += res.freed;
                changed = true;
            }
            if (withOrphans) {
                const res = await api.post("/api/cache/orphans/clear");
                freed += res.freed;
                withOrphans = false;
                changed = true;
            }
        } catch (err) {
            busy = false;
            render(err.message);
            return;
        }
        busy = false;
        await load(`已释放 ${formatBytes(freed)}`);
    }

    render();
    await load();
    await modal.closed;
    return changed;
}
