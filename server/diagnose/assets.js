// The assets side of the scan: what the script points at, and what is actually in game/.
//
// Nothing here is judged. A file that is not there, an extension that lies about the format, two
// files with the same bytes, a clip in a format a browser will not play: all of it is a fact about
// the original, and what to do about it is not this file's business.
//
// The scan only reads. File heads are read for every media file; whole files are read only inside
// a group that already shares a byte size, and only up to a budget, so a game with tens of
// gigabytes of video is not read end to end to find a duplicate.

import crypto from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";

const TOP = 60;
const SAMPLES = 5;
const HASH_BUDGET = 512 * 1024 * 1024;

// Ren'Py defines these itself, so a `show` of one is not a missing image.
// (renpy/common/00definitions.rpy and 00defaults.rpy)
const BUILTIN_TAGS = new Set(["black", "text", "vtext"]);
// Ren'Py looks a reference up as written and then under the folder that goes with its kind, which
// is why `play music "voice/a.mp3"` finds game/audio/voice/a.mp3. (renpy/loader.py get_prefixes)
const SEARCH_PREFIXES = { image: ["", "images/"], audio: ["", "audio/"] };
// What `_scan_images_directory` picks up from game/images/**. (renpy/common/00images.rpy)
const AUTO_IMAGE_EXT = new Set([".jpg", ".jpeg", ".png", ".webp", ".avif", ".svg"]);

const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".webp", ".avif", ".svg", ".gif", ".bmp", ".tif", ".tiff"]);
const AUDIO_EXT = new Set([".ogg", ".oga", ".opus", ".mp3", ".wav", ".flac", ".m4a", ".aac", ".wma", ".aiff", ".aif", ".mid", ".midi"]);
const VIDEO_EXT = new Set([".webm", ".mp4", ".m4v", ".mov", ".avi", ".ogv", ".mkv", ".wmv", ".mpg", ".mpeg", ".flv"]);
const FONT_EXT = new Set([".ttf", ".otf", ".woff", ".woff2", ".ttc"]);

/** Formats that have to be converted before a browser can play or show them. */
const OFFLINE_EXT = new Map([
    [".avi", "视频"], [".ogv", "视频"], [".wmv", "视频"], [".mkv", "视频"], [".mov", "视频"],
    [".mpg", "视频"], [".mpeg", "视频"], [".flv", "视频"],
    [".bmp", "图片"], [".tif", "图片"], [".tiff", "图片"],
    [".wma", "音频"], [".aiff", "音频"], [".aif", "音频"], [".mid", "音频"], [".midi", "音频"],
]);

/** What a file's first bytes have to say for its extension to be honest. */
const EXPECTED_FORMAT = {
    ".png": ["png"], ".jpg": ["jpeg"], ".jpeg": ["jpeg"], ".gif": ["gif"], ".webp": ["webp"],
    ".bmp": ["bmp"], ".avif": ["avif"], ".svg": ["svg"], ".tif": ["tiff"], ".tiff": ["tiff"],
    ".ogg": ["ogg", "opus", "ogv"], ".oga": ["ogg", "opus"], ".opus": ["opus", "ogg"],
    ".ogv": ["ogv", "ogg"], ".wav": ["wav"], ".mp3": ["mp3"], ".flac": ["flac"],
    ".m4a": ["m4a", "mp4"], ".mp4": ["mp4", "m4a"], ".m4v": ["mp4"], ".mov": ["mov", "mp4"],
    ".avi": ["avi"], ".webm": ["webm", "matroska"], ".mkv": ["matroska", "webm"],
    ".ttf": ["ttf"], ".ttc": ["ttf"], ".otf": ["otf", "ttf"], ".woff": ["woff"], ".woff2": ["woff2"],
};

const FORMAT_NAMES = {
    png: "PNG", jpeg: "JPEG", gif: "GIF", webp: "WebP", bmp: "BMP", avif: "AVIF", svg: "SVG",
    tiff: "TIFF", ogg: "Ogg Vorbis", opus: "Opus", ogv: "Ogg Theora", wav: "WAV", mp3: "MP3",
    flac: "FLAC", mp4: "MP4", m4a: "M4A", mov: "QuickTime", avi: "AVI", webm: "WebM",
    matroska: "Matroska", riff: "RIFF（不是 WAV/AVI/WebP）", ttf: "TrueType", otf: "OpenType",
    woff: "WOFF", woff2: "WOFF2",
};

const ext = (p) => path.extname(p).toLowerCase();
const isMedia = (p) => IMAGE_EXT.has(ext(p)) || AUDIO_EXT.has(ext(p)) || VIDEO_EXT.has(ext(p)) || FONT_EXT.has(ext(p));

/** The format the first bytes say this is, or null when they say nothing recognisable. */
export function detectFormat(buf) {
    if (!buf || buf.length < 8) return null;
    const at = (a, b) => buf.subarray(a, b).toString("latin1");
    const head = at(0, 4);
    const all = at(0, buf.length);
    if (head === "\x89PNG") return "png";
    if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "jpeg";
    if (head === "GIF8") return "gif";
    if (head === "RIFF") {
        const kind = at(8, 12);
        if (kind === "WEBP") return "webp";
        if (kind === "WAVE") return "wav";
        if (kind.startsWith("AVI")) return "avi";
        return "riff";
    }
    if (head === "OggS") {
        if (all.includes("OpusHead")) return "opus";
        if (all.includes("theora")) return "ogv";
        return "ogg";
    }
    if (head === "fLaC") return "flac";
    if (buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) {
        return all.includes("webm") ? "webm" : "matroska";
    }
    if (at(4, 8) === "ftyp") {
        const brand = at(8, 12);
        if (brand.startsWith("avif") || brand.startsWith("avis")) return "avif";
        if (brand.startsWith("qt")) return "mov";
        if (brand.startsWith("M4A")) return "m4a";
        return "mp4";
    }
    if (head.startsWith("ID3") || (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0)) return "mp3";
    if (buf[0] === 0x42 && buf[1] === 0x4d) return "bmp";
    if (head === "II*\0" || head === "MM\0*") return "tiff";
    if (head === "OTTO") return "otf";
    if (head === "wOFF") return "woff";
    if (head === "wOF2") return "woff2";
    if (head === "true" || head === "ttcf" || (buf[0] === 0 && buf[1] === 1 && buf[2] === 0 && buf[3] === 0)) return "ttf";
    const start = all.replace(/^\s+/, "");
    if (start.startsWith("<?xml") || start.startsWith("<svg")) return "svg";
    return null;
}

async function readHead(file, bytes = 64) {
    const fh = await fsp.open(file, "r");
    try {
        const buf = Buffer.alloc(bytes);
        const { bytesRead } = await fh.read(buf, 0, bytes, 0);
        return buf.subarray(0, bytesRead);
    } finally {
        await fh.close();
    }
}

async function sha256(file) {
    const hash = crypto.createHash("sha256");
    const fh = await fsp.open(file, "r");
    try {
        const buf = Buffer.alloc(1 << 20);
        for (;;) {
            const { bytesRead } = await fh.read(buf, 0, buf.length, null);
            if (!bytesRead) break;
            hash.update(buf.subarray(0, bytesRead));
        }
    } finally {
        await fh.close();
    }
    return hash.digest("hex");
}

/** Groups references by the path they point at, keeping a few sites of each. */
function group(refs, key) {
    const map = new Map();
    for (const r of refs) {
        const k = key(r);
        if (k == null) continue;
        const row = map.get(k) ?? { name: String(k), count: 0, sites: [], statements: new Set() };
        row.count++;
        if (row.sites.length < SAMPLES) row.sites.push(`${r.file}:${r.line}`);
        if (r.statement) row.statements.add(r.statement);
        map.set(k, row);
    }
    return [...map.values()]
        .map((r) => ({ ...r, statements: [...r.statements] }))
        .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

/**
 * Image names Ren'Py defines by itself from the files under game/images/: the base name, lowercased,
 * with the `@2` oversampling suffix dropped, split on spaces into a tag and its attributes.
 */
function autoDefinedTags(files) {
    const tags = new Set();
    let scanned = 0;
    for (const f of files) {
        if (!f.startsWith("images/") || !AUTO_IMAGE_EXT.has(ext(f))) continue;
        scanned++;
        const base = path.basename(f, path.extname(f)).toLowerCase().split("@")[0];
        const first = base.trim().split(/\s+/)[0];
        if (first) tags.add(first);
    }
    return { tags, scanned };
}

/**
 * Compares what the script points at with what is in game/.
 * @param {object} col the collector, after the pass over the sources
 * @param {string[]} files every file under game/, relative, with "/" separators
 * @param {string} gameDir the absolute game/ folder, read for file heads and sizes
 */
export async function buildAssets(col, files, gameDir) {
    const onDisk = new Set(files);
    // Ren'Py's loader lowercases and NFC-normalises before it looks a file up, so a reference whose
    // spelling differs only in case does load. On a case-sensitive target it does not.
    const norm = (s) => s.normalize("NFC").toLowerCase();
    const byNorm = new Map();
    for (const f of files) if (!byNorm.has(norm(f))) byNorm.set(norm(f), f);
    const archives = files.filter((f) => ext(f) === ".rpa");

    const resolve = (ref) => {
        const prefixes = SEARCH_PREFIXES[ref.kind] ?? [""];
        for (const p of prefixes) if (onDisk.has(p + ref.path)) return { how: p ? "prefix" : "exact", path: p + ref.path };
        for (const p of prefixes) {
            const hit = byNorm.get(norm(p + ref.path));
            if (hit) return { how: "case", path: hit };
        }
        return null;
    };

    // ---- what the script points at
    const refs = [];
    const usedTags = new Set(col.imageUses.map((u) => u.tag.toLowerCase()));
    // The same image name defined twice: the last definition is the one the game runs with, so an
    // earlier one is dead code, and the file it points at not being there changes nothing.
    const lastOfName = new Map();
    col.imageDefs.forEach((d, i) => lastOfName.set(d.name, i));
    col.imageDefs.forEach((d, i) => {
        for (const p of d.paths) {
            refs.push({
                path: p, kind: "image", tag: d.tag, tagShown: usedTags.has(d.tag.toLowerCase()),
                superseded: lastOfName.get(d.name) !== i,
                statement: `${d.statement} ${d.name}`, file: d.file, line: d.line,
            });
        }
    });
    for (const a of col.audioRefs) {
        refs.push({ path: a.path, kind: "audio", tag: null, tagShown: true, superseded: false, statement: `${a.statement} ${a.channel ?? ""}`.trim(), file: a.file, line: a.line });
    }

    const missing = [];
    const caseMismatch = [];
    let viaPrefix = 0;
    for (const r of refs) {
        const found = resolve(r);
        if (!found) missing.push({ ...r, onDisk: null });
        else if (found.how === "case") caseMismatch.push({ ...r, onDisk: found.path });
        else if (found.how === "prefix") viaPrefix++;
    }
    // `tagShown` says the tag of this definition appears in a `show`/`scene` somewhere. It does
    // not say this definition is the one those lines resolve to: a tag usually has dozens of
    // definitions that differ only by attributes, and which one a line picks depends on the
    // attributes the stage carries at that moment.
    const missingRows = group(missing, (r) => r.path).map((row) => {
        const mine = missing.filter((r) => r.path === row.name);
        return {
            path: row.name, references: row.count, statements: row.statements, sites: row.sites,
            kind: mine[0]?.kind ?? null, tag: mine[0]?.tag ?? null,
            tagShown: mine.some((r) => r.tagShown),
            superseded: mine.every((r) => r.superseded),
        };
    });
    const caseRows = group(caseMismatch, (r) => r.path).map((row) => ({
        path: row.name, onDisk: caseMismatch.find((r) => r.path === row.name)?.onDisk ?? null,
        references: row.count, sites: row.sites,
    }));

    // ---- tags shown but never defined
    const defined = new Set();
    for (const d of col.imageDefs) defined.add(d.tag.toLowerCase());
    const auto = autoDefinedTags(files);
    const unknownUses = col.imageUses.filter((u) => {
        const t = u.tag.toLowerCase();
        return !defined.has(t) && !auto.tags.has(t) && !BUILTIN_TAGS.has(t);
    });
    const asRows = (uses) => group(uses, (u) => u.tag).map((row) => ({
        tag: row.name, uses: row.count, statements: row.statements, sites: row.sites,
    }));
    // A `show` of a tag nothing defines stops the game at that line. A Character's `image=` tag is
    // only resolved when a line says the character's name with attributes, so it may never be
    // reached; it is listed apart.
    const unknownTags = asRows(unknownUses.filter((u) => u.statement === "show" || u.statement === "scene"));
    const unknownCharacterImages = asRows(unknownUses.filter((u) => u.statement === "Character(image=)"));

    // ---- what is on disk: format, size, duplicate content
    const media = files.filter(isMedia);
    const formatMismatch = [];
    const bySize = new Map();
    let mediaBytes = 0;
    for (const f of media) {
        const full = path.join(gameDir, ...f.split("/"));
        let size;
        try {
            size = (await fsp.stat(full)).size;
        } catch {
            continue;
        }
        mediaBytes += size;
        if (size > 0) {
            const bucket = bySize.get(size) ?? [];
            bucket.push(f);
            bySize.set(size, bucket);
        }
        const expected = EXPECTED_FORMAT[ext(f)];
        if (!expected) continue;
        let actual = null;
        try {
            actual = detectFormat(await readHead(full));
        } catch {
            continue;
        }
        if (actual && !expected.includes(actual)) {
            formatMismatch.push({ path: f, extension: ext(f), actual, actualName: FORMAT_NAMES[actual] ?? actual, bytes: size });
        }
    }

    // Only files that already share a byte size can have the same content.
    const duplicates = [];
    let hashedBytes = 0;
    let hashTruncated = false;
    for (const [size, bucket] of [...bySize.entries()].sort((a, b) => b[0] - a[0])) {
        if (bucket.length < 2) continue;
        if (hashedBytes + size * bucket.length > HASH_BUDGET) {
            hashTruncated = true;
            continue;
        }
        const byHash = new Map();
        for (const f of bucket) {
            try {
                const h = await sha256(path.join(gameDir, ...f.split("/")));
                hashedBytes += size;
                byHash.set(h, [...(byHash.get(h) ?? []), f]);
            } catch {
                /* unreadable file: nothing to compare */
            }
        }
        for (const group_ of byHash.values()) {
            if (group_.length > 1) duplicates.push({ bytes: size, files: group_.sort() });
        }
    }
    duplicates.sort((a, b) => b.files.length * b.bytes - a.files.length * a.bytes);

    // ---- what has to be dealt with outside the port
    const maskedMovies = col.imageDefs
        .filter((d) => d.constructor === "Movie" && d.mask)
        .map((d) => ({ name: d.name, play: d.paths[0] ?? null, mask: d.mask, file: d.file, line: d.line }));
    const matrixColor = col.imageDefs
        .filter((d) => d.constructor && d.constructor.startsWith("im."))
        .map((d) => ({ name: d.name, constructor: d.constructor, source: d.paths[0] ?? null, expression: d.expression, file: d.file, line: d.line }));

    const offline = new Map();
    const noteOffline = (p, where) => {
        const kind = OFFLINE_EXT.get(ext(p));
        if (!kind) return;
        const row = offline.get(ext(p)) ?? { extension: ext(p), kind, files: new Set(), referenced: 0, sites: [] };
        row.files.add(p);
        if (where) {
            row.referenced++;
            if (row.sites.length < SAMPLES) row.sites.push(where);
        }
        offline.set(ext(p), row);
    };
    for (const r of refs) noteOffline(r.path, `${r.file}:${r.line}`);
    for (const f of media) noteOffline(f, null);
    const offlineFormats = [...offline.values()]
        .map((r) => ({ ...r, files: [...r.files].sort(), count: r.files.size }))
        .sort((a, b) => b.count - a.count || a.extension.localeCompare(b.extension));

    // A name defined twice is not an error, but it is why the first definition's file can be
    // missing without the game ever noticing: the last one wins.
    const byName = new Map();
    for (const d of col.imageDefs) byName.set(d.name, [...(byName.get(d.name) ?? []), d]);
    const redefined = [...byName.entries()]
        .filter(([, list]) => list.length > 1)
        .map(([name, list]) => ({
            name, count: list.length,
            sites: list.map((d) => `${d.file}:${d.line}`).slice(0, SAMPLES),
            paths: [...new Set(list.flatMap((d) => d.paths))].slice(0, SAMPLES),
        }))
        .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));

    const cap = (list) => list.slice(0, TOP);
    return {
        version: 1,
        summary: {
            imageDefinitions: col.imageDefs.length,
            referencedPaths: new Set(refs.map((r) => r.path)).size,
            imageReferences: refs.filter((r) => r.kind === "image").length,
            audioReferences: refs.filter((r) => r.kind === "audio").length,
            missingPaths: missingRows.length,
            missingTagShown: missingRows.filter((r) => r.tagShown && !r.superseded).length,
            missingSuperseded: missingRows.filter((r) => r.superseded).length,
            missingAudio: missingRows.filter((r) => r.kind === "audio").length,
            caseMismatches: caseRows.length,
            resolvedViaPrefix: viaPrefix,
            shownTags: new Set(col.imageUses.filter((u) => u.statement === "show" || u.statement === "scene").map((u) => u.tag.toLowerCase())).size,
            unknownTags: unknownTags.length,
            unknownCharacterImages: unknownCharacterImages.length,
            formatMismatches: formatMismatch.length,
            duplicateGroups: duplicates.length,
            duplicateFiles: duplicates.reduce((n, d) => n + d.files.length, 0),
            wastedBytes: duplicates.reduce((n, d) => n + d.bytes * (d.files.length - 1), 0),
            maskedMovies: maskedMovies.length,
            matrixColor: matrixColor.length,
            offlineFormats: offlineFormats.length,
            redefinedNames: redefined.length,
            mediaFiles: media.length,
            mediaBytes,
        },
        missing: cap(missingRows.sort((a, b) => Number(a.superseded) - Number(b.superseded) || Number(b.tagShown) - Number(a.tagShown) || a.path.localeCompare(b.path))),
        missingTruncated: missingRows.length > TOP,
        caseMismatch: cap(caseRows),
        unknownTags: cap(unknownTags),
        unknownCharacterImages: cap(unknownCharacterImages),
        formatMismatch: cap(formatMismatch.sort((a, b) => a.path.localeCompare(b.path))),
        duplicates: cap(duplicates),
        offline: { maskedMovies: cap(maskedMovies), matrixColor: cap(matrixColor), formats: offlineFormats },
        redefined: cap(redefined),
        notes: {
            archives: archives.length,
            autoDefinedImages: auto.scanned,
            hashedBytes,
            hashTruncated,
        },
    };
}
