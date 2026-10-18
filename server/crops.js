// Element crops of a captured screen. The game makes them when the migrator picks "crop" after F9;
// the WebUI can make or change them later, cropping in the browser (canvas) and sending PNG bytes.
// Each crop is crop-<n>.png next to the screen's full.png, where n is the element's number in
// elements.json, and its record (rectangle, type, label, source line) goes in the shot's metadata.

import fs from "node:fs";
import path from "node:path";
import { HttpError } from "./http.js";

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const MAX_CROP_BYTES = 16 * 1024 * 1024;
const RECORD_KEYS = ["type", "label", "text", "screen", "location", "image", "id"];

const isRect = (r) => Array.isArray(r) && r.length === 4 && r.every((v) => typeof v === "number" && Number.isFinite(v));

/**
 * Replaces the crops in `dir` with `wanted`: entries with `png` (base64) are written, entries
 * without it keep their existing file, and crop files no longer listed are removed. Returns the
 * stored records, largest first.
 */
export function writeCrops(dir, wanted) {
    if (!Array.isArray(wanted)) throw new HttpError(400, "切图格式无效", "bad_crops");
    const keep = new Map();
    for (const c of wanted) {
        const n = Number(c?.n);
        if (!Number.isInteger(n) || n < 0 || !isRect(c.rect)) throw new HttpError(400, "切图格式无效", "bad_crops");
        const file = `crop-${n}.png`;
        if (typeof c.png === "string") {
            const buf = Buffer.from(c.png.replace(/^data:image\/png;base64,/, ""), "base64");
            if (buf.length > MAX_CROP_BYTES || buf.subarray(0, 8).compare(PNG_SIGNATURE) !== 0) {
                throw new HttpError(400, "切图不是有效的 PNG", "bad_png");
            }
            fs.writeFileSync(path.join(dir, file), buf);
        } else if (!fs.existsSync(path.join(dir, file))) {
            throw new HttpError(400, "缺少切图数据", "missing_png");
        }
        const record = { n, file, rect: c.rect.map((v) => Math.round(v * 10) / 10) };
        if (isRect(c.rect1920)) record.rect1920 = c.rect1920.map((v) => Math.round(v * 10) / 10);
        for (const k of RECORD_KEYS) if (c[k] !== undefined && c[k] !== null) record[k] = c[k];
        keep.set(n, record);
    }
    for (const name of fs.readdirSync(dir)) {
        const m = /^crop-(\d+)\.png$/.exec(name);
        if (m && !keep.has(Number(m[1]))) fs.rmSync(path.join(dir, name), { force: true });
    }
    return [...keep.values()].sort((a, b) => b.rect[2] * b.rect[3] - a.rect[2] * a.rect[3]);
}
