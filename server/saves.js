// Ren'Py save files, for "capture from saves": list a folder's saves, read the thumbnail and name
// stored inside each one, and stage the chosen ones where the capture run will load them.
//
// A .save file is a zip archive (screenshot.png, extra_info, json, log, signatures). The reader
// below handles the stored and deflated entries Ren'Py writes; it never extracts to disk.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import crypto from "node:crypto";

const EOCD = 0x06054b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;

/** Lists a zip's entries: name → { method, compressedSize, size, offset }. */
export function zipEntries(buf) {
    let eocd = -1;
    for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
        if (buf.readUInt32LE(i) === EOCD) {
            eocd = i;
            break;
        }
    }
    if (eocd < 0) throw new Error("not a zip file");
    const count = buf.readUInt16LE(eocd + 10);
    let p = buf.readUInt32LE(eocd + 16);
    const entries = new Map();
    for (let n = 0; n < count; n++) {
        if (buf.readUInt32LE(p) !== CENTRAL) throw new Error("bad central directory");
        const method = buf.readUInt16LE(p + 10);
        const compressedSize = buf.readUInt32LE(p + 20);
        const size = buf.readUInt32LE(p + 24);
        const nameLen = buf.readUInt16LE(p + 28);
        const extraLen = buf.readUInt16LE(p + 30);
        const commentLen = buf.readUInt16LE(p + 32);
        const offset = buf.readUInt32LE(p + 42);
        const name = buf.toString("utf8", p + 46, p + 46 + nameLen);
        entries.set(name, { method, compressedSize, size, offset });
        p += 46 + nameLen + extraLen + commentLen;
    }
    return entries;
}

export function zipRead(buf, entry) {
    if (buf.readUInt32LE(entry.offset) !== LOCAL) throw new Error("bad local header");
    const nameLen = buf.readUInt16LE(entry.offset + 26);
    const extraLen = buf.readUInt16LE(entry.offset + 28);
    const start = entry.offset + 30 + nameLen + extraLen;
    const data = buf.subarray(start, start + entry.compressedSize);
    if (entry.method === 0) return Buffer.from(data);
    if (entry.method === 8) return zlib.inflateRawSync(data);
    throw new Error(`unsupported zip method ${entry.method}`);
}

/** The save's slot name, the name the player gave it, its time, and whether it has a thumbnail. */
/** Ren'Py 8 names a slot's file "<slot>-LT1.save"; older versions "<slot>.save". */
export function slotOf(fileName) {
    return fileName.replace(/(-LT\d+)?\.save$/, "");
}

export function describeSave(file) {
    const slot = slotOf(path.basename(file));
    const st = fs.statSync(file);
    const info = { file: path.basename(file), slot, mtime: st.mtime.toISOString(), name: null, thumbnail: false };
    try {
        const buf = fs.readFileSync(file);
        const entries = zipEntries(buf);
        info.thumbnail = entries.has("screenshot.png");
        const extra = entries.get("extra_info");
        if (extra) info.name = zipRead(buf, extra).toString("utf8") || null;
        const json = entries.get("json");
        if (json) {
            const meta = JSON.parse(zipRead(buf, json).toString("utf8"));
            if (!info.name && meta._save_name) info.name = meta._save_name;
        }
    } catch {
        info.unreadable = true;
    }
    return info;
}

/** Save slots sorted newest first. Ren'Py's own files (persistent, navigation) are not saves. */
export function listSaves(dir) {
    let names;
    try {
        names = fs.readdirSync(dir);
    } catch {
        return [];
    }
    return names
        .filter((n) => n.endsWith(".save"))
        .map((n) => describeSave(path.join(dir, n)))
        .sort((a, b) => (a.mtime < b.mtime ? 1 : -1));
}

export function saveThumbnail(dir, fileName) {
    if (!/^[^/\\]+\.save$/.test(fileName)) throw new Error("bad save name");
    const buf = fs.readFileSync(path.join(dir, fileName));
    const entry = zipEntries(buf).get("screenshot.png");
    return entry ? zipRead(buf, entry) : null;
}

/** Where Ren'Py keeps this machine's save tokens. */
export function userTokenFile() {
    if (process.env.REN2LEAF_RENPY_TOKENS) return process.env.REN2LEAF_RENPY_TOKENS;
    if (process.platform === "darwin") return path.join(os.homedir(), "Library", "RenPy", "tokens", "security_keys.txt");
    if (process.platform === "win32") return path.join(process.env.APPDATA || "", "RenPy", "tokens", "security_keys.txt");
    return path.join(os.homedir(), ".renpy", "tokens", "security_keys.txt");
}

/**
 * Copies the chosen saves (and the folder's persistent file) into `<savesRoot>/<saveDirectory>`,
 * and this machine's public verifying keys into `<savesRoot>/tokens`.
 *
 * Only public keys are written: the file's `verifying-key` lines, plus the public half of each
 * `signing-key` (derived in memory; the private key is never written anywhere). Saves made on this
 * machine then pass Ren'Py's check as they would in the player's own copy, saves from elsewhere
 * still do not.
 */
export function stageSaves({ sourceDir, files, savesRoot, saveDirectory }) {
    fs.rmSync(savesRoot, { recursive: true, force: true });
    const target = path.join(savesRoot, saveDirectory);
    fs.mkdirSync(target, { recursive: true });
    for (const f of files) {
        if (!/^[^/\\]+\.save$/.test(f)) throw new Error("bad save name");
        fs.copyFileSync(path.join(sourceDir, f), path.join(target, f));
    }
    const persistent = path.join(sourceDir, "persistent");
    if (fs.existsSync(persistent)) fs.copyFileSync(persistent, path.join(target, "persistent"));

    const keys = publicKeyLines(userTokenFile());
    if (keys.length) {
        fs.mkdirSync(path.join(savesRoot, "tokens"), { recursive: true });
        fs.writeFileSync(path.join(savesRoot, "tokens", "security_keys.txt"), keys.join("\n") + "\n");
    }
    return { target, verifyingKeys: keys.length };
}

/** `verifying-key <base64 SPKI DER>` lines for every key in a Ren'Py security_keys.txt. */
export function publicKeyLines(tokenFile) {
    let text;
    try {
        text = fs.readFileSync(tokenFile, "utf8");
    } catch {
        return [];
    }
    const out = new Set();
    for (const line of text.split(/\r?\n/)) {
        const [kind, b64] = line.trim().split(/\s+/);
        if (!b64) continue;
        try {
            if (kind === "verifying-key") {
                out.add(`verifying-key ${b64}`);
            } else if (kind === "signing-key") {
                const priv = crypto.createPrivateKey({ key: Buffer.from(b64, "base64"), format: "der", type: "sec1" });
                const spki = crypto.createPublicKey(priv).export({ format: "der", type: "spki" });
                out.add(`verifying-key ${spki.toString("base64")}`);
            }
        } catch {
            // A line this version cannot parse is skipped; Ren'Py will simply not trust that key.
        }
    }
    return [...out];
}

/** Finds `define config.save_directory = "..."` in the game's scripts. */
export function readSaveDirectory(gameRoot) {
    const re = /config\.save_directory\s*=\s*(?:u)?["']([^"']+)["']/;
    const walk = (d) => {
        let entries;
        try {
            entries = fs.readdirSync(d, { withFileTypes: true });
        } catch {
            return null;
        }
        for (const e of entries) {
            const p = path.join(d, e.name);
            if (e.isDirectory()) {
                if (e.name === "saves" || e.name === "cache" || e.name === "tl") continue;
                const hit = walk(p);
                if (hit) return hit;
            } else if (e.name.endsWith(".rpy")) {
                const m = re.exec(fs.readFileSync(p, "utf8"));
                if (m) return m[1];
            }
        }
        return null;
    };
    return walk(path.join(gameRoot, "game"));
}

/** The folder Ren'Py uses for this game's saves on this machine, when it exists. */
export function defaultSaveDir(saveDirectory) {
    if (!saveDirectory) return null;
    const base = process.platform === "darwin" ? path.join(os.homedir(), "Library", "RenPy")
        : process.platform === "win32" ? path.join(process.env.APPDATA || "", "RenPy")
        : path.join(os.homedir(), ".renpy");
    const p = path.join(base, saveDirectory);
    return fs.existsSync(p) ? p : null;
}
