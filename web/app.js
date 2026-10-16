// Shell: game list, step strip, status bar, and the shared dialog / menu / tooltip pieces.
//
// A step lives in web/steps/<id>.js and exports `mount(host, ctx)`, which may return an unmount
// function. ctx: { game, api, confirm, openModal, openMenu, icon, setStatus, refreshGame }.

const STEPS = [
    { id: "diagnose", label: "诊断" },
    { id: "capture", label: "截图" },
    { id: "speakers", label: "说话人", disabled: true },
    { id: "python", label: "Python 逻辑", disabled: true },
    { id: "flow", label: "流程与章节", disabled: true },
];

const ICONS = {
    plus: '<path d="M5 12h14"/><path d="M12 5v14"/>',
    more: '<circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/>',
    x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
    folder: '<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>',
    trash: '<path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/>',
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
 * Opens a Studio-style dialog. `body` is a Node or a string; `footer` is a list of
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
        localStorage.setItem("ren2leaf.shell", JSON.stringify({ gameId: state.gameId, step: state.step }));
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
    const list = $("game-list");
    list.replaceChildren();
    $("game-count").textContent = state.games.length ? String(state.games.length) : "";
    for (const game of state.games) {
        const selected = game.id === state.gameId;
        const menuBtn = h("button", {
            type: "button",
            class: "tool-btn tool-btn-xs row-menu-btn",
            "aria-label": "更多",
            "aria-haspopup": "menu",
            "aria-expanded": "false",
            html: icon("more"),
            onclick: (e) => {
                e.stopPropagation();
                if (openMenuState?.anchor === e.currentTarget) {
                    closeMenu();
                    return;
                }
                openMenu(e.currentTarget, [
                    { label: "在 Finder 中显示", icon: "folder", onSelect: () => reveal(game.id, "game") },
                    "sep",
                    { label: "移除", icon: "trash", danger: true, onSelect: () => removeGame(game) },
                ]);
            },
        });
        const row = h("div", {
            class: "game-row",
            role: "option",
            tabindex: selected ? "0" : "-1",
            "aria-selected": selected ? "true" : "false",
            "data-id": game.id,
            onclick: () => selectGame(game.id),
            onkeydown: (e) => onRowKey(e, game.id),
        },
        h("span", { class: "game-row-name" }, game.name),
        game.present ? null : h("span", { class: "game-row-missing", "data-tip": "目录不存在" }),
        menuBtn);
        list.append(row);
    }
    if (!state.gameId && list.firstChild) list.firstChild.tabIndex = 0;
    list.append(h("button", {
        type: "button",
        class: "add-row",
        html: icon("plus") + "<span>添加游戏</span>",
        onclick: () => addGameDialog(),
    }));
}

function onRowKey(e, id) {
    const rows = [...document.querySelectorAll(".game-row")];
    const i = rows.findIndex((r) => r.dataset.id === id);
    if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        selectGame(id);
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const next = rows[e.key === "ArrowDown" ? Math.min(i + 1, rows.length - 1) : Math.max(i - 1, 0)];
        if (next) {
            selectGame(next.dataset.id);
            document.querySelector(`.game-row[data-id="${next.dataset.id}"]`)?.focus();
        }
    }
}

async function reveal(id, target) {
    try {
        await api.post(`/api/games/${id}/reveal`, { target });
    } catch (err) {
        openModal({ title: "无法显示", body: err.message, footer: [{ label: "好", variant: "primary" }] });
    }
}

async function removeGame(game) {
    try {
        await api.del(`/api/games/${game.id}`);
    } catch (err) {
        openModal({ title: "无法移除", body: err.message, footer: [{ label: "好", variant: "primary" }] });
        return;
    }
    state.games = state.games.filter((g) => g.id !== game.id);
    if (state.gameId === game.id) state.gameId = state.games[0]?.id || null;
    renderAll();
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
    const strip = $("steps");
    strip.replaceChildren();
    for (const step of STEPS) {
        const selected = step.id === state.step;
        strip.append(h("button", {
            type: "button",
            class: "tab",
            role: "tab",
            "aria-selected": selected ? "true" : "false",
            "aria-disabled": step.disabled ? "true" : null,
            tabindex: selected ? "0" : "-1",
            "data-tip": step.disabled ? "未开放" : null,
            onclick: () => !step.disabled && selectStep(step.id),
            onkeydown: (e) => {
                if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
                const open = STEPS.filter((s) => !s.disabled);
                const i = open.findIndex((s) => s.id === state.step);
                const next = open[(i + (e.key === "ArrowRight" ? 1 : -1) + open.length) % open.length];
                selectStep(next.id);
                strip.querySelector('[aria-selected="true"]')?.focus();
            },
        }, step.label));
    }
}

function emptyState(title, action) {
    return h("div", { class: "empty-state" },
        h("div", { class: "empty-state-icon", html: icon("layers") }),
        h("p", { class: "empty-state-title" }, title),
        action ? h("div", { class: "empty-state-action" }, action) : null);
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
    if (!game) {
        host.append(emptyState("还没有游戏", h("button", {
            type: "button",
            class: "btn btn-primary",
            onclick: () => addGameDialog(),
        }, "添加游戏")));
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
        host.replaceChildren(emptyState("这一步加载失败"));
    }
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
    const bar = $("statusbar");
    bar.replaceChildren();
    const game = currentGame();
    if (!game) return;
    const meta = game.meta || {};
    const values = [
        meta.sdk ? `Ren'Py ${meta.sdk}` : null,
        meta.resolution || null,
        meta.lastRunAt ? formatTime(meta.lastRunAt) : null,
        ...Object.values(state.status),
    ].filter(Boolean);
    for (const v of values) bar.append(h("span", { class: "status-item" }, v));
    bar.append(h("button", {
        type: "button",
        class: "status-item is-action mono",
        "data-tip": "在 Finder 中显示",
        onclick: () => reveal(game.id, "work"),
    }, game.workDir.replace(/^\/Users\/[^/]+/, "~")));
}

// ------------------------------------------------------------------ navigation

function renderHead() {
    const game = currentGame();
    $("workspace-head").hidden = !game;
    $("game-title").textContent = game?.name || "";
    document.title = game ? `${game.name} · Ren2Leaf` : "Ren2Leaf";
    renderSteps();
}

function renderAll() {
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
    $("add-game-head").innerHTML = icon("plus");
    $("add-game-head").addEventListener("click", () => addGameDialog());
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
    const step = fromHash.step || stored.step;
    if (STEPS.some((s) => s.id === step && !s.disabled)) state.step = step;
    renderAll();
}

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
