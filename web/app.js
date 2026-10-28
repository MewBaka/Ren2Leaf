// Shell: game list, step strip, status bar, and the shared dialog / menu / tooltip pieces.
//
// A step lives in web/steps/<id>.js and exports `mount(host, ctx)`, which may return an unmount
// function. ctx: { game, api, confirm, openModal, openMenu, icon, setStatus, refreshGame }.

const STEPS = [
    { id: "diagnose", label: "诊断", icon: "pulse" },
    { id: "capture", label: "截图", icon: "camera" },
    { id: "speakers", label: "说话人", icon: "users" },
    { id: "flow", label: "流程与章节", icon: "branch" },
    { id: "export", label: "导出补充包", icon: "package" },
];

const ICONS = {
    plus: '<path d="M5 12h14"/><path d="M12 5v14"/>',
    more: '<circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/>',
    x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
    folder: '<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>',
    broom: '<path d="M13 11l9-9"/><path d="M14.6 12.6c.8.8.9 2 .2 2.7l-1.3 1.3c-.7.7-1.9.6-2.7-.2L7.4 12.8c-.8-.8-.9-2-.2-2.7l1.3-1.3c.7-.7 1.9-.6 2.7.2Z"/><path d="M6 15a6 6 0 0 0-3 5c0 1 .5 1.5 1.5 1.5a6 6 0 0 0 5-3"/>',
    trash: '<path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/>',
    pulse: '<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>',
    camera: '<path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z"/><circle cx="12" cy="13" r="3"/>',
    users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
    code: '<path d="m16 18 6-6-6-6"/><path d="m8 6-6 6 6 6"/>',
    branch: '<circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="6" r="3"/><path d="M6 9v6"/><path d="M18 9a9 9 0 0 1-9 9"/>',
    chevrons: '<path d="m7 15 5 5 5-5"/><path d="m7 9 5-5 5 5"/>',
    "panel-collapse": '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M9 3v18"/><path d="m14 9-3 3 3 3"/>',
    "panel-expand": '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M9 3v18"/><path d="m12 9 3 3-3 3"/>',
    package: '<path d="m7.5 4.27 9 5.15"/><path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"/><path d="m3.3 7 8.7 5 8.7-5"/><path d="M12 22V12"/>',
    check: '<path d="M20 6 9 17l-5-5"/>',
    layers: '<path d="m12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83Z"/><path d="m22 17.65-9.17 4.16a2 2 0 0 1-1.66 0L2 17.65"/><path d="m22 12.65-9.17 4.16a2 2 0 0 1-1.66 0L2 12.65"/>',
};

export function icon(name) {
    return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ""}</svg>`;
}

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

// ------------------------------------------------------------------ api

export class ApiError extends Error {
    constructor(message, code, status) {
        super(message);
        this.code = code;
        this.status = status;
    }
}

async function request(method, url, body) {
    const init = { method, headers: {} };
    if (body !== undefined) {
        init.headers["Content-Type"] = "application/json";
        init.body = JSON.stringify(body);
    }
    const res = await fetch(url, init);
    if (res.status === 204) return null;
    const data = await res.json().catch(() => null);
    if (!res.ok) {
        throw new ApiError(data?.error?.message || `请求失败 ${res.status}`, data?.error?.code, res.status);
    }
    return data;
}

export const api = {
    get: (url) => request("GET", url),
    post: (url, body = {}) => request("POST", url, body),
    put: (url, body = {}) => request("PUT", url, body),
    del: (url) => request("DELETE", url),
};

// ------------------------------------------------------------------ tooltip (data-tip)

const TIP_DELAY = 500;
const TIP_WARM_MS = 300;
let tipEl = null;
let tipTarget = null;
let tipTimer = 0;
let tipHiddenAt = 0;

function placeTip(target) {
    const text = target.getAttribute("data-tip");
    if (!text) return;
    if (!tipEl) tipEl = h("div", { class: "tooltip", role: "tooltip" });
    tipEl.textContent = text;
    document.body.append(tipEl);
    const r = target.getBoundingClientRect();
    const t = tipEl.getBoundingClientRect();
    const gap = 6;
    const side = target.closest("[data-tip-side]")?.getAttribute("data-tip-side") || "top";
    let top;
    let left = r.left + r.width / 2 - t.width / 2;
    if (side === "right") {
        left = r.right + gap;
        top = r.top + r.height / 2 - t.height / 2;
    } else if (side === "bottom" || r.top - t.height - gap < 4) {
        top = r.bottom + gap;
    } else {
        top = r.top - t.height - gap;
    }
    left = Math.max(4, Math.min(left, innerWidth - t.width - 4));
    top = Math.max(4, Math.min(top, innerHeight - t.height - 4));
    tipEl.style.left = `${left}px`;
    tipEl.style.top = `${top}px`;
}

function hideTip() {
    clearTimeout(tipTimer);
    if (tipEl?.isConnected) {
        tipEl.remove();
        tipHiddenAt = performance.now();
    }
    tipTarget = null;
}

// Resolved by hit-testing so that disabled controls still get their tip.
document.addEventListener("pointermove", (e) => {
    const hit = document.elementFromPoint(e.clientX, e.clientY);
    const target = hit?.closest?.("[data-tip]") || null;
    if (target === tipTarget) return;
    const wasShowing = tipEl?.isConnected;
    hideTip();
    if (!target) return;
    tipTarget = target;
    const warm = wasShowing || performance.now() - tipHiddenAt < TIP_WARM_MS;
    if (warm) placeTip(target);
    else tipTimer = setTimeout(() => tipTarget === target && placeTip(target), TIP_DELAY);
});
document.addEventListener("pointerdown", hideTip, true);
document.addEventListener("scroll", hideTip, true);
window.addEventListener("blur", hideTip);

// ------------------------------------------------------------------ menu

let openMenuState = null;

function closeMenu() {
    if (!openMenuState) return;
    const { el, anchor, onKey, onDown } = openMenuState;
    el.remove();
    anchor?.setAttribute("aria-expanded", "false");
    document.removeEventListener("keydown", onKey, true);
    document.removeEventListener("pointerdown", onDown, true);
    openMenuState = null;
}

/** items: [{ label, icon?, danger?, onSelect } | "sep"] */
export function openMenu(anchor, items) {
    closeMenu();
    hideTip();
    const el = h("div", { class: "menu", role: "menu" });
    for (const item of items) {
        if (item === "sep") {
            el.append(h("div", { class: "menu-sep", role: "separator" }));
            continue;
        }
        el.append(h("button", {
            type: "button",
            role: "menuitem",
            class: item.danger ? "menu-item is-danger" : "menu-item",
            html: (item.icon ? icon(item.icon) : "") + `<span></span>`,
            onclick: () => {
                closeMenu();
                item.onSelect?.();
            },
        }));
        el.lastChild.querySelector("span").textContent = item.label;
    }
    document.body.append(el);
    const r = anchor.getBoundingClientRect();
    const m = el.getBoundingClientRect();
    let left = r.left;
    let top = r.bottom + 4;
    if (left + m.width > innerWidth - 4) left = r.right - m.width;
    if (top + m.height > innerHeight - 4) top = r.top - m.height - 4;
    el.style.left = `${Math.max(4, left)}px`;
    el.style.top = `${Math.max(4, top)}px`;
    anchor.setAttribute("aria-expanded", "true");

    const buttons = [...el.querySelectorAll(".menu-item")];
    const onKey = (e) => {
        if (e.key === "Escape") {
            e.stopPropagation();
            closeMenu();
            anchor.focus();
        } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            const i = buttons.indexOf(document.activeElement);
            const next = e.key === "ArrowDown" ? (i + 1) % buttons.length : (i - 1 + buttons.length) % buttons.length;
            buttons[next]?.focus();
        }
    };
    const onDown = (e) => {
        if (!el.contains(e.target) && !anchor.contains(e.target)) closeMenu();
    };
    document.addEventListener("keydown", onKey, true);
    document.addEventListener("pointerdown", onDown, true);
    openMenuState = { el, anchor, onKey, onDown };
    return closeMenu;
}

// ------------------------------------------------------------------ modal

const modalStack = [];

document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape" || !modalStack.length || openMenuState) return;
    e.preventDefault();
    modalStack[modalStack.length - 1].dismiss();
});

/**
 * Opens a dialog. `body` is a Node or a string; `footer` is a list of
 * { label, variant: "primary" | "secondary" | "danger", onClick(close) }. Resolves `closed`
 * with whatever `close(value)` was called with (undefined when dismissed).
 */
export function openModal({ title, body, footer = [], dismissible = true, width }) {
    hideTip();
    let resolve;
    const closed = new Promise((r) => { resolve = r; });
    const previousFocus = document.activeElement;
    const layer = h("div", { class: "modal-layer" });
    const backdrop = h("div", { class: "modal-backdrop" });
    const panel = h("div", { class: "modal", role: "dialog", "aria-modal": "true" });
    if (width) panel.style.maxWidth = `${width}px`;

    const close = (value) => {
        if (!layer.isConnected) return;
        layer.remove();
        const i = modalStack.indexOf(entry);
        if (i >= 0) modalStack.splice(i, 1);
        previousFocus?.focus?.();
        resolve(value);
    };
    const entry = { dismiss: () => dismissible && close(undefined) };

    const head = h("div", { class: "modal-head" }, h("h2", { class: "modal-title" }, title || ""));
    if (dismissible) {
        head.append(h("button", {
            type: "button",
            class: "tool-btn",
            "aria-label": "关闭",
            html: icon("x"),
            onclick: () => close(undefined),
        }));
    }
    const bodyEl = h("div", { class: "modal-body" });
    if (typeof body === "string") bodyEl.append(h("p", {}, body));
    else if (body) bodyEl.append(body);

    panel.append(head, bodyEl);
    const buttons = {};
    if (footer.length) {
        const foot = h("div", { class: "modal-foot" });
        for (const b of footer) {
            const btn = h("button", {
                type: "button",
                class: `btn btn-${b.variant === "secondary" || !b.variant ? "quiet" : b.variant}`,
                onclick: () => b.onClick ? b.onClick(close) : close(b.value),
            }, b.label);
            if (b.id) buttons[b.id] = btn;
            foot.append(btn);
        }
        panel.append(foot);
    }

    let pressStartedOnBackdrop = false;
    backdrop.addEventListener("pointerdown", () => { pressStartedOnBackdrop = true; });
    backdrop.addEventListener("click", () => {
        if (pressStartedOnBackdrop) entry.dismiss();
        pressStartedOnBackdrop = false;
    });
    panel.addEventListener("keydown", (e) => {
        if (e.key !== "Tab") return;
        const focusables = [...panel.querySelectorAll("button:not(:disabled), input:not(:disabled), select, textarea, [tabindex]:not([tabindex='-1'])")];
        if (!focusables.length) return;
        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        if (e.shiftKey && document.activeElement === first) {
            e.preventDefault();
            last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
            e.preventDefault();
            first.focus();
        }
    });

    layer.append(backdrop, panel);
    document.body.append(layer);
    modalStack.push(entry);
    const autofocus = panel.querySelector("[autofocus]") || panel.querySelector(".modal-foot .btn:last-child") || panel;
    autofocus.focus?.();
    return { close, closed, panel, body: bodyEl, buttons };
}

/** Resolves true when confirmed. `tone: "danger"` paints the confirm button red. */
export function confirm({ title, message, confirmText = "确认", cancelText = "取消", tone = "primary" }) {
    const modal = openModal({
        title,
        body: message,
        footer: [
            { label: cancelText, variant: "secondary", value: false },
            { label: confirmText, variant: tone === "danger" ? "danger" : "primary", value: true },
        ],
    });
    return modal.closed.then((v) => v === true);
}

// ------------------------------------------------------------------ state

const state = {
    games: [],
    gameId: null,
    step: "diagnose",
    status: {},
    collapsed: false,
    unmount: null,
    mountToken: 0,
};

const $ = (id) => document.getElementById(id);

function readStored() {
    try {
        return JSON.parse(localStorage.getItem("ren2leaf.shell") || "{}");
    } catch {
        return {};
    }
}

function store() {
    try {
        localStorage.setItem("ren2leaf.shell", JSON.stringify({ gameId: state.gameId, step: state.step, collapsed: state.collapsed }));
    } catch {
        // Storage may be unavailable; the hash still carries the location.
    }
}

function parseHash() {
    const m = /^#\/game\/([0-9a-f]{10})(?:\/([a-z]+))?/.exec(location.hash);
    return m ? { gameId: m[1], step: m[2] } : {};
}

function writeHash() {
    const next = state.gameId ? `#/game/${state.gameId}/${state.step}` : "#/";
    if (location.hash !== next) history.replaceState(null, "", next);
}

function currentGame() {
    return state.games.find((g) => g.id === state.gameId) || null;
}

// ------------------------------------------------------------------ sidebar

function renderSidebar() {
    const box = $("switcher");
    box.replaceChildren();
    const game = currentGame();
    const trigger = h("button", {
        type: "button",
        class: "switcher-btn",
        "aria-haspopup": "menu",
        "data-tip": state.collapsed ? (game ? game.name : "添加游戏") : null,
        onclick: (e) => openSwitcher(e.currentTarget),
    },
    h("span", { class: "switcher-avatar", "aria-hidden": "true" }, game ? game.name.slice(0, 1) : "+"),
    h("span", { class: "switcher-text" },
        h("span", { class: "switcher-name" }, game ? game.name : "添加游戏"),
        h("span", { class: "switcher-sub" }, game ? (game.present ? `${state.games.length} 个游戏` : "目录不存在") : "选择游戏目录")),
    h("span", { class: "switcher-chevron", html: icon("chevrons") }));
    box.append(trigger);
}

function openSwitcher(anchor) {
    if (!state.games.length) {
        addGameDialog();
        return;
    }
    const game = currentGame();
    const items = state.games.map((g) => ({
        label: g.name,
        icon: g.id === state.gameId ? "check" : "blank",
        onSelect: () => selectGame(g.id),
    }));
    items.push("sep", { label: "添加游戏", icon: "plus", onSelect: () => addGameDialog() });
    if (game) {
        items.push(
            { label: "在 Finder 中显示", icon: "folder", onSelect: () => reveal(game.id, "game") },
            { label: "清理缓存…", icon: "broom", onSelect: () => cleanCache(game) },
            { label: "移除当前游戏", icon: "trash", danger: true, onSelect: () => removeGame(game) },
        );
    }
    openMenu(anchor, items);
    const menu = document.querySelector(".menu");
    if (menu) menu.style.minWidth = `${anchor.getBoundingClientRect().width}px`;
}

async function reveal(id, target) {
    try {
        await api.post(`/api/games/${id}/reveal`, { target });
    } catch (err) {
        openModal({ title: "无法显示", body: err.message, footer: [{ label: "确定", variant: "primary" }] });
    }
}

async function removeGame(game) {
    try {
        await api.del(`/api/games/${game.id}`);
    } catch (err) {
        openModal({ title: "无法移除", body: err.message, footer: [{ label: "确定", variant: "primary" }] });
        return;
    }
    state.games = state.games.filter((g) => g.id !== game.id);
    if (state.gameId === game.id) state.gameId = state.games[0]?.id || null;
    renderAll();
}

/** The work directory's cache, cleared from a dialog the shell loads on demand. */
async function cleanCache(game) {
    const { openCacheDialog } = await import("./cache.js");
    // A cleared scan or screenshot set changes what every step reads, so remount the one on screen.
    if (await openCacheDialog(game)) {
        await refreshGame();
        mountStep();
    }
}

// ------------------------------------------------------------------ add game

function addGameDialog() {
    const input = h("input", {
        class: "input mono",
        type: "text",
        spellcheck: "false",
        autocomplete: "off",
        placeholder: "/path/to/game",
        autofocus: true,
    });
    const pickBtn = h("button", { type: "button", class: "btn btn-secondary" }, "选择…");
    const error = h("div", { class: "field-error", hidden: true });
    const body = h("div", { class: "field" },
        h("label", { class: "field-label" }, "游戏目录"),
        h("div", { class: "field-row" }, input, pickBtn),
        error);

    const modal = openModal({
        title: "添加游戏",
        body,
        footer: [
            { label: "取消", variant: "secondary" },
            { id: "add", label: "添加", variant: "primary", onClick: () => submit() },
        ],
    });
    const addBtn = modal.buttons.add;
    const sync = () => { addBtn.disabled = !input.value.trim(); };
    sync();
    input.focus();

    const showError = (msg) => {
        error.textContent = msg;
        error.hidden = !msg;
        input.setAttribute("aria-invalid", msg ? "true" : "false");
    };

    async function submit() {
        const value = input.value.trim();
        if (!value) return;
        addBtn.disabled = true;
        try {
            const { game } = await api.post("/api/games", { path: value });
            modal.close(game);
            await loadGames();
            selectGame(game.id);
        } catch (err) {
            showError(err.message);
            sync();
        }
    }

    input.addEventListener("input", () => {
        showError("");
        sync();
    });
    input.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && !e.isComposing) submit();
    });
    pickBtn.addEventListener("click", async () => {
        pickBtn.disabled = true;
        try {
            const res = await api.post("/api/games/pick");
            if (res?.path) {
                input.value = res.path;
                showError("");
                sync();
                await submit();
            }
        } catch (err) {
            showError(err.message);
        } finally {
            pickBtn.disabled = false;
        }
    });
}

// ------------------------------------------------------------------ steps

function renderSteps() {
    const nav = $("steps");
    nav.replaceChildren();
    STEPS.forEach((step, i) => {
        const selected = step.id === state.step;
        nav.append(h("button", {
            type: "button",
            class: "nav-item",
            "data-tip": state.collapsed ? `${i + 1}　${step.label}` : null,
            "aria-current": selected ? "page" : null,
            "aria-disabled": step.disabled ? "true" : null,
            disabled: !currentGame() && !step.disabled ? true : null,
            onclick: () => !step.disabled && selectStep(step.id),
        },
        h("span", { class: "nav-icon", html: icon(step.icon) }),
        h("span", { class: "nav-text" }, step.label),
        step.disabled ? h("span", { class: "nav-badge" }, "即将推出") : h("span", { class: "nav-index" }, String(i + 1))));
    });
}

function emptyState(title, action) {
    return h("div", { class: "empty-state" },
        h("div", { class: "empty-state-icon", html: icon("layers") }),
        h("p", { class: "empty-state-title" }, title),
        action ? h("div", { class: "empty-state-action" }, action) : null);
}

const SKILLS_COMMAND = "npx skills add NarraLeaf/Skills -g";
const AGENT_DOCS = "https://www.narraleaf.com/zh/docs/studio/agent";
const PORT_SKILL_DIR = "skills/narraleaf-port-renpy/";

/** The first thing anyone sees: what this tool does, and what to do before handing work to an agent. */
function welcome() {
    const reasons = [
        "扫描项目源码，标记可迁移的代码段及需由 Agent 决策的设计点",
        "对游戏界面元素进行截图与切图，使 Agent 直接识别元素布局，而非仅从代码推算",
        "配置角色别名与分类，避免将别名或非关键 NPC 误建为独立角色",
        "规划剧本流程与章节结构，提升迁移后的可维护性",
    ];
    // Said before the list, because it is the expectation to set: the scanner is the part that
    // breaks on an unconventional game, not the port itself.
    const caveat = h("div", { class: "welcome-tip" },
        h("p", {}, "即使项目未遵循 Ren'Py 开发规范，Agent 仍可完成迁移；但本工具可能因非标准写法出现解析异常"),
        h("p", {}, "已知的非标准写法已做兼容处理，其余情况将由 Agent 自行判断"));
    const note = h("div", { class: "welcome-note" },
        h("p", {}, "配置完成后，Ren2Leaf 将生成一份迁移补充包。请将游戏源码与补充包一并发送给 Agent"),
        h("p", {}, "在此之前，请先安装 NarraLeaf Skills："),
        h("pre", { class: "welcome-code" }, SKILLS_COMMAND),
        h("p", {}, "Ren'Py 移植 Skill 随本工具一同发布，位于 Ren2Leaf 仓库的",
            h("code", {}, PORT_SKILL_DIR), " 目录下，请将其一并提供给 Agent"),
        h("p", {}, "NarraLeaf Studio Agent 接入相关事宜，请参阅文档：",
            h("a", { class: "welcome-link", href: AGENT_DOCS, target: "_blank", rel: "noreferrer" }, AGENT_DOCS)));
    const inner = h("div", { class: "welcome-inner" },
        h("h1", { class: "welcome-title" }, "将游戏迁移至 NarraLeaf"),
        h("p", { class: "welcome-lead" }, "本工具协助开发者借助 Agent 将 Ren'Py 项目高质量迁移至 NarraLeaf Studio"),
        h("button", {
            type: "button",
            class: "btn btn-primary btn-lg welcome-cta",
            onclick: () => addGameDialog(),
        }, "添加游戏"),
        caveat,
        h("h2", { class: "welcome-heading" }, "相比直接迁移，Ren2Leaf 提供了哪些增强？"),
        h("ol", { class: "welcome-list" }, reasons.map((t) => h("li", {}, t))),
        note);
    return h("div", { class: "welcome" }, inner);
}

async function mountStep() {
    const token = ++state.mountToken;
    const host = $("step-host");
    if (state.unmount) {
        try {
            state.unmount();
        } catch (err) {
            console.error(err);
        }
        state.unmount = null;
    }
    host.replaceChildren();
    const game = currentGame();
    mountStepNote(game, state.step, token);
    if (!game) {
        host.append(welcome());
        return;
    }
    const url = `./steps/${state.step}.js`;
    const exists = await fetch(url, { method: "HEAD" }).then((r) => r.ok, () => false);
    if (token !== state.mountToken) return;
    if (!exists) {
        host.append(emptyState("暂无内容"));
        return;
    }
    try {
        const mod = await import(url);
        if (token !== state.mountToken) return;
        const ctx = {
            game,
            api,
            confirm,
            openModal,
            openMenu,
            icon,
            setStatus,
            refreshGame,
        };
        const result = await mod.mount(host, ctx);
        if (token !== state.mountToken) {
            if (typeof result === "function") result();
            return;
        }
        state.unmount = typeof result === "function" ? result : null;
    } catch (err) {
        console.error(err);
        if (token !== state.mountToken) return;
        host.replaceChildren(emptyState("当前步骤加载失败"));
    }
}

// ------------------------------------------------------------------ step note

/** The steps that fill a section of the package, and so can carry a note to the agent for it. */
const NOTE_STEPS = new Set(["diagnose", "capture", "speakers", "flow"]);
const NOTE_SAVE_DELAY = 600;
let flushStepNote = null;

/**
 * The box under every step that writes part of the package: what the migrator wants the agent to
 * know about this part. It lives in the shell, so every step gets the same one, and it saves as it
 * is typed into, so leaving the step never loses it.
 */
async function mountStepNote(game, step, token) {
    const bar = $("step-note");
    flushStepNote?.();
    flushStepNote = null;
    bar.replaceChildren();
    bar.hidden = true;
    if (!game || !NOTE_STEPS.has(step)) return;
    let saved = "";
    try {
        saved = (await api.get(`/api/games/${game.id}/document/decisions`)).document?.notes?.[step] ?? "";
    } catch {
        return;
    }
    if (token !== state.mountToken) return;

    const area = h("textarea", {
        class: "step-note-input",
        rows: "2",
        maxlength: "4000",
        placeholder: "扫描看不出、或需要 Agent 特别注意的内容，导出时写在补充包对应章节的开头",
        "aria-label": "此部分给 Agent 的备注",
    }, saved);
    const status = h("span", { class: "step-note-status" });
    const show = (text, danger = false) => {
        status.textContent = text;
        status.classList.toggle("is-danger", danger);
    };
    let timer = 0;
    const save = async () => {
        clearTimeout(timer);
        timer = 0;
        const value = area.value;
        if (value === saved) return;
        show("正在保存");
        try {
            await api.put(`/api/games/${game.id}/document/decisions`, { notes: { [step]: value } });
            saved = value;
            show(value.trim() ? "已保存" : "");
        } catch (err) {
            show(err.message, true);
        }
    };
    const grow = () => {
        area.style.height = "auto";
        area.style.height = `${area.scrollHeight + 2}px`;
    };
    area.addEventListener("input", () => {
        show("");
        grow();
        clearTimeout(timer);
        timer = setTimeout(save, NOTE_SAVE_DELAY);
    });
    area.addEventListener("blur", () => save());
    flushStepNote = () => { if (timer) save(); };

    bar.append(
        h("div", { class: "step-note-head" },
            h("span", { class: "step-note-label" }, "此部分给 Agent 的备注"),
            status),
        area);
    bar.hidden = false;
    grow();
}

// ------------------------------------------------------------------ status bar

/** Steps can put a value in the status bar under a key; null removes it. */
export function setStatus(key, value) {
    if (value === null || value === undefined || value === "") delete state.status[key];
    else state.status[key] = value;
    renderStatus();
}

function formatTime(iso) {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return null;
    const pad = (n) => String(n).padStart(2, "0");
    return `${d.getMonth() + 1}月${d.getDate()}日 ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function renderStatus() {
    const foot = $("statusbar");
    const meta = $("topbar-meta");
    foot.replaceChildren();
    meta.replaceChildren();
    const game = currentGame();
    if (!game) return;
    const m = game.meta || {};
    const values = [
        m.sdk ? `Ren'Py ${m.sdk}` : null,
        m.resolution || null,
        m.lastRunAt ? `更新于 ${formatTime(m.lastRunAt)}` : null,
        ...Object.values(state.status),
    ].filter(Boolean);
    for (const v of values) meta.append(h("span", { class: "meta-pill" }, v));
    const short = game.workDir.replace(/^\/Users\/[^/]+/, "~");
    if (state.collapsed) {
        foot.append(h("button", {
            type: "button",
            class: "foot-icon",
            "aria-label": "在 Finder 中显示工作目录",
            "data-tip": short,
            html: icon("folder"),
            onclick: () => reveal(game.id, "work"),
        }));
        return;
    }
    foot.append(h("div", { class: "foot-label" }, "工作目录"));
    foot.append(h("button", {
        type: "button",
        class: "foot-path mono",
        "data-tip": "在 Finder 中显示",
        onclick: () => reveal(game.id, "work"),
    }, short));
}

// ------------------------------------------------------------------ navigation

function renderHead() {
    const game = currentGame();
    $("workspace-head").hidden = !game;
    $("game-title").textContent = game?.name || "";
    $("step-title").textContent = STEPS.find((s) => s.id === state.step)?.label || "";
    document.title = game ? `${game.name} · Ren2Leaf` : "Ren2Leaf";
    renderSteps();
}

/** Sidebar collapsed to icons: the labels move into the tooltips the shell already has. */
function renderShell() {
    const shell = document.querySelector(".shell");
    shell.classList.toggle("is-collapsed", state.collapsed);
    const btn = $("sidebar-toggle");
    btn.innerHTML = icon(state.collapsed ? "panel-expand" : "panel-collapse");
    btn.setAttribute("aria-label", state.collapsed ? "展开侧边栏" : "折叠侧边栏");
    btn.setAttribute("aria-expanded", state.collapsed ? "false" : "true");
    btn.setAttribute("data-tip", state.collapsed ? "展开侧边栏" : "折叠侧边栏");
}

function toggleSidebar() {
    state.collapsed = !state.collapsed;
    store();
    renderShell();
    renderSidebar();
    renderSteps();
    renderStatus();
}

function renderAll() {
    renderShell();
    renderSidebar();
    renderHead();
    renderStatus();
    writeHash();
    store();
    mountStep();
}

export function selectGame(id) {
    if (id === state.gameId) return;
    state.gameId = id;
    state.status = {};
    renderAll();
}

export function selectStep(step) {
    if (step === state.step || STEPS.find((s) => s.id === step)?.disabled) return;
    state.step = step;
    renderHead();
    writeHash();
    store();
    mountStep();
}

async function loadGames() {
    const { games } = await api.get("/api/games");
    state.games = games;
}

/** Re-reads one game (after a step updated its meta) and refreshes the chrome without remounting. */
export async function refreshGame() {
    const id = state.gameId;
    if (!id) return null;
    const { game } = await api.get(`/api/games/${id}`);
    state.games = state.games.map((g) => (g.id === id ? game : g));
    renderSidebar();
    renderHead();
    renderStatus();
    return game;
}

async function boot() {
    try {
        await loadGames();
    } catch (err) {
        $("step-host").replaceChildren(emptyState("无法连接服务"));
        return;
    }
    const fromHash = parseHash();
    const stored = readStored();
    const want = fromHash.gameId || stored.gameId;
    state.gameId = state.games.some((g) => g.id === want) ? want : state.games[0]?.id || null;
    state.collapsed = stored.collapsed === true;
    const step = fromHash.step || stored.step;
    if (STEPS.some((s) => s.id === step && !s.disabled)) state.step = step;
    renderAll();
}

$("sidebar-toggle").addEventListener("click", toggleSidebar);

window.addEventListener("hashchange", () => {
    const { gameId, step } = parseHash();
    if (gameId && gameId !== state.gameId && state.games.some((g) => g.id === gameId)) {
        state.gameId = gameId;
        state.status = {};
        if (step && STEPS.some((s) => s.id === step && !s.disabled)) state.step = step;
        renderAll();
    } else if (step && step !== state.step) {
        selectStep(step);
    }
});

boot();
