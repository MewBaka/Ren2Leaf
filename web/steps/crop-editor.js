// Crops in the WebUI: choose elements of a captured screen, largest first, and save each as its own
// picture. Cropping happens here, on a canvas; the server stores the PNG bytes it is sent.

function h(tag, attrs = {}, ...children) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
        if (v === undefined || v === null || v === false) continue;
        if (k === "class") el.className = v;
        else if (k === "style" && typeof v === "object") Object.assign(el.style, v);
        else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
        else el.setAttribute(k, v === true ? "" : v);
    }
    for (const c of children.flat()) {
        if (c === null || c === undefined || c === false) continue;
        el.append(c instanceof Node ? c : document.createTextNode(String(c)));
    }
    return el;
}

const PRIORITY = ["Button", "Input", "Bar", "Text", "Window", "Frame", "Viewport", "VPGrid", "Grid", "Side",
    "Image", "ImageReference", "Movie", "Solid"];

/** What can be cropped: elements smaller than the screen, one per rectangle, largest first. */
export function cropCandidates(elements, gameSize) {
    const [gw, gh] = gameSize;
    const best = new Map();
    for (const e of elements || []) {
        const [, , w, hh] = e.rect;
        if (w < 4 || hh < 4 || (w >= gw - 1 && hh >= gh - 1)) continue;
        if (String(e.info || e.image || "").includes("_transparent_tile")) continue;
        const key = e.rect.map((v) => Math.round(v)).join(",");
        const rank = PRIORITY.includes(e.type) ? PRIORITY.indexOf(e.type) : 99;
        if (!best.has(key) || rank < best.get(key).rank) best.set(key, { rank, e });
    }
    return [...best.values()].map((v) => v.e).sort((a, b) => b.rect[2] * b.rect[3] - a.rect[2] * a.rect[3]);
}

export function cropTitle(e) {
    return `${e.type}  ${Math.round(e.rect[2])}×${Math.round(e.rect[3])}`;
}

export function cropName(e) {
    return e.label ?? e.text ?? e.screen ?? "";
}

/** A thumbnail of a region of the full picture, drawn with CSS only. */
export function regionThumb(imageUrl, gameSize, rect, boxW, boxH) {
    const [x, y, w, hh] = rect;
    const k = Math.min(boxW / w, boxH / hh);
    return h("div", { class: "crop-thumb", style: { width: `${boxW}px`, height: `${boxH}px` } },
        h("div", {
            class: "crop-thumb-img",
            style: {
                width: `${Math.max(1, w * k)}px`,
                height: `${Math.max(1, hh * k)}px`,
                backgroundImage: `url("${imageUrl}")`,
                backgroundSize: `${gameSize[0] * k}px ${gameSize[1] * k}px`,
                backgroundPosition: `${-x * k}px ${-y * k}px`,
            },
        }));
}

function loadImage(url) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error("截图加载失败"));
        img.src = url;
    });
}

/** PNG bytes (base64) of one region of the full picture, at the game's pixels. */
async function cropPng(img, gameSize, rect) {
    const sx = img.naturalWidth / gameSize[0];
    const sy = img.naturalHeight / gameSize[1];
    const [x, y, w, hh] = rect;
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(w * sx));
    canvas.height = Math.max(1, Math.round(hh * sy));
    canvas.getContext("2d").drawImage(img, x * sx, y * sy, w * sx, hh * sy, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/png").split(",")[1];
}

/**
 * Opens the crop dialog. `crops` are the crops already saved (records with n). `onSave(list)` gets
 * the records to store, each with `png` when it is new.
 */
export function openCropEditor(ctx, { imageUrl, gameSize, elements, crops = [], onSave }) {
    const candidates = cropCandidates(elements, gameSize);
    const known = new Set(candidates.map((e) => e.n));
    const chosen = new Set((crops || []).map((c) => c.n).filter((n) => known.has(n)));
    const existing = new Set(chosen);
    const [gw, gh] = gameSize;

    const preview = h("div", { class: "crop-preview" }, h("img", { src: imageUrl, alt: "" }));
    const marks = h("div", { class: "crop-marks" });
    preview.append(marks);
    const place = ([x, y, w, hh]) => ({ left: `${(x / gw) * 100}%`, top: `${(y / gh) * 100}%`, width: `${(w / gw) * 100}%`, height: `${(hh / gh) * 100}%` });
    let hover = null;
    const drawMarks = () => {
        marks.replaceChildren();
        for (const e of candidates) if (chosen.has(e.n)) marks.append(h("div", { class: "crop-mark", style: place(e.rect) }));
        if (hover) marks.append(h("div", { class: "crop-mark is-hover", style: place(hover.rect) }));
    };

    const list = h("div", { class: "crop-list" });
    const tiles = new Map();
    for (const e of candidates) {
        const tile = h("button", {
            type: "button",
            class: "crop-tile",
            "aria-pressed": chosen.has(e.n) ? "true" : "false",
            onclick: () => {
                if (chosen.has(e.n)) chosen.delete(e.n);
                else chosen.add(e.n);
                tile.setAttribute("aria-pressed", chosen.has(e.n) ? "true" : "false");
                drawMarks();
                sync();
            },
            onmouseenter: () => { hover = e; drawMarks(); },
            onmouseleave: () => { hover = null; drawMarks(); },
        },
        regionThumb(imageUrl, gameSize, e.rect, 148, 74),
        h("span", { class: "crop-tile-title" }, cropTitle(e)),
        h("span", { class: "crop-tile-name" }, cropName(e)),
        h("span", { class: "crop-tile-check", "aria-hidden": "true" }));
        tiles.set(e.n, tile);
        list.append(tile);
    }
    if (!candidates.length) list.append(h("p", { class: "cap-note" }, "该画面没有可切的元素"));

    const modal = ctx.openModal({
        title: "切图",
        body: h("div", { class: "crop-editor" },
            h("div", { class: "crop-side" }, preview, h("p", { class: "crop-hint" }, "按尺寸从大到小排列，点击选择")),
            list),
        width: 1080,
        footer: [
            { label: "取消", variant: "secondary" },
            {
                id: "save",
                label: "保存",
                variant: "primary",
                onClick: async (close) => {
                    const btn = modal.buttons.save;
                    btn.disabled = true;
                    try {
                        const img = await loadImage(imageUrl);
                        const out = [];
                        for (const e of candidates) {
                            if (!chosen.has(e.n)) continue;
                            const record = { n: e.n, rect: e.rect, rect1920: e.rect1920, type: e.type, label: e.label,
                                text: e.text, screen: e.screen, location: e.location, image: e.image, id: e.id };
                            if (!existing.has(e.n)) record.png = await cropPng(img, gameSize, e.rect);
                            out.push(record);
                        }
                        await onSave(out);
                        close(true);
                    } catch (err) {
                        btn.disabled = false;
                        btn.textContent = err.message;
                    }
                },
            },
        ],
    });
    modal.panel.classList.add("crop-modal");
    const sync = () => {
        const n = chosen.size;
        modal.buttons.save.textContent = n ? `保存 ${n} 张切图` : "清除切图";
    };
    drawMarks();
    sync();
    return modal;
}

/** Saved crops as a gallery of cards; hovering one calls onHover(rect or null). */
export function cropGallery(crops, fileUrl, onHover) {
    const grid = h("div", { class: "crop-gallery" });
    for (const c of crops) {
        grid.append(h("a", {
            class: "crop-card",
            href: fileUrl(c.file),
            target: "_blank",
            rel: "noopener",
            onmouseenter: () => onHover?.(c.rect),
            onmouseleave: () => onHover?.(null),
        },
        h("div", { class: "crop-card-img" }, h("img", { src: fileUrl(c.file), alt: "" })),
        h("span", { class: "crop-tile-title" }, cropTitle(c)),
        h("span", { class: "crop-tile-name" }, [cropName(c), c.location ? `${c.location[0].replace(/^game\//, "")}:${c.location[1]}` : ""].filter(Boolean).join(" · "))));
    }
    return grid;
}
