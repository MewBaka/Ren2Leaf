// A picture for each speaker, so the migrator recognises who a variable is without reading code.
//
// Where it comes from, strongest first; the source travels with the picture so nobody mistakes a
// guess for a fact:
//   image=    the Character's own side image — the author said so
//   variable  an image folder or file named like the variable (`define eileen` ↔ images/char/eileen/)
//   sprite    the sprite tag standing on stage for most of that speaker's lines, and only when
//             no other speaker has a better claim on that tag
// A speaker with no match gets no picture: a background cropped into an avatar says nothing, and
// the step shows the name instead.

import fs from "node:fs";
import path from "node:path";
import { HttpError, sendFile } from "./http.js";

const IMAGE_EXT = new Set([".png", ".webp", ".jpg", ".jpeg", ".avif"]);
const SKIP_DIRS = new Set(["cache", "saves", "tl", "gui", "audio", "bgm", "se", "videos", "fonts", "__pycache__"]);
const MAX_FILES = 20000;
const DOMINANT_SHARE = 0.6;
// A tag seen beside only a handful of lines proves nothing, however exclusive it looks.
const MIN_TAG_LINES = 10;
// Tags and folders that hold scenery, not people. A background is never a speaker's picture.
const SCENERY_TAG = /^(bg|cg|ev|apng|movie|video|qcg|black|white)[\s_\-0-9]?/i;
const SCENERY_DIR = /^(bg|bgs?|background|backgrounds|cg|cgs|qcg|event|events|scene|scenes|video|videos|apng)$/i;

/** Every image file under game/, by lower-cased path. Walked once per request; games are local. */
export function imageIndex(gameDir) {
    const files = [];
    const visit = (dir, depth) => {
        if (files.length >= MAX_FILES || depth > 6) return;
        let entries;
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
            return;
        }
        for (const e of entries) {
            if (e.name.startsWith(".")) continue;
            const full = path.join(dir, e.name);
            if (e.isDirectory()) {
                if (!SKIP_DIRS.has(e.name.toLowerCase())) visit(full, depth + 1);
            } else if (e.isFile() && IMAGE_EXT.has(path.extname(e.name).toLowerCase())) {
                files.push(full);
            }
        }
    };
    visit(gameDir, 0);
    return files;
}

/** How well `file` answers to the image tag `tag`; 0 means no. */
function score(file, gameDir, tag) {
    const rel = path.relative(gameDir, file).split(path.sep).join("/").toLowerCase();
    const t = tag.toLowerCase();
    const base = path.basename(rel, path.extname(rel));
    const parent = path.basename(path.dirname(rel));
    if (parent === t) return 4;
    if (base === t) return 4;
    if (new RegExp(`^${t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[ _\\-.]`).test(base)) return 3;
    if (rel.split("/").some((part) => part === t)) return 2;
    if (base.includes(t) && t.length >= 3) return 1;
    return 0;
}

/** The best file for an image tag, or null. */
export function fileForTag(index, gameDir, tag) {
    if (!tag || tag.length < 2) return null;
    let best = null;
    let bestScore = 0;
    for (const file of index) {
        const s = score(file, gameDir, tag);
        if (s > bestScore || (s === bestScore && s > 0 && file.length < best.length)) {
            best = file;
            bestScore = s;
        }
    }
    return bestScore >= 2 ? best : null;
}

/**
 * What to try for each speaker, best grounds first.
 * @param {Array} speakers the speakers section's list
 * @returns {Map<string, Array<{tag: string, source: string}>>}
 */
export function portraitPlan(speakers) {
    // A sprite tag belongs to the speaker who stood next to it most; the others do not get it.
    const claim = new Map();
    for (const sp of speakers) {
        for (const t of sp.spriteTags ?? []) {
            const prev = claim.get(t.tag);
            if (!prev || t.lines > prev.lines) claim.set(t.tag, { variable: sp.variable, lines: t.lines });
        }
    }
    const plan = new Map();
    for (const sp of speakers) {
        const tries = [];
        if (sp.image) tries.push({ tag: sp.image, source: "image" });
        const top = (sp.spriteTags ?? []).find((t) => !SCENERY_TAG.test(t.tag));
        // A tag only counts for the speaker who stood next to it most.
        const mine = top && claim.get(top.tag)?.variable === sp.variable;
        const share = top && sp.lines ? top.lines / sp.lines : 0;
        if (mine && share >= DOMINANT_SHARE) tries.push({ tag: top.tag, source: "sprite" });
        if (sp.variable.length >= 2) tries.push({ tag: sp.variable, source: "variable" });
        if (mine && share < DOMINANT_SHARE && top.lines >= MIN_TAG_LINES) tries.push({ tag: top.tag, source: "sprite" });
        plan.set(sp.variable, tries);
    }
    return plan;
}

/**
 * Resolves every speaker's picture to a file on disk.
 * @returns {Map<string, {file: string, source: string, tag: string|null}>} portraits only
 */
export function resolvePortraits(game, speakers) {
    const gameDir = path.join(game.path, "game");
    const index = imageIndex(gameDir);
    const plan = portraitPlan(speakers);
    const out = new Map();
    for (const sp of speakers) {
        let hit = null;
        for (const want of plan.get(sp.variable) ?? []) {
            let file = fileForTag(index, gameDir, want.tag);
            // A match that lands in the backgrounds is scenery that happens to share a name.
            if (file && want.source !== "image") {
                const parts = path.relative(gameDir, file).split(path.sep);
                if (parts.some((part) => SCENERY_DIR.test(part))) file = null;
            }
            if (file) {
                hit = { file, source: want.source, tag: want.tag };
                break;
            }
        }
        if (hit) out.set(sp.variable, hit);
    }
    return out;
}

const SOURCE_LABEL = {
    image: "来自角色的 image= 设定",
    variable: "按变量名找到的图片",
    sprite: "按台上立绘 tag 找到的图片",
};

export function register(router, { games }) {
    const speakersOf = (game) => {
        let inventory;
        try {
            inventory = JSON.parse(fs.readFileSync(path.join(game.workDir, "inventory.json"), "utf8"));
        } catch {
            return [];
        }
        return inventory.extensions?.speakers?.speakers ?? [];
    };

    router.get("/api/games/:id/speakers/portraits", ({ params }) => {
        const game = games.get(params.id);
        const speakers = speakersOf(game);
        const found = resolvePortraits(game, speakers);
        const portraits = {};
        for (const [variable, p] of found) {
            portraits[variable] = {
                source: p.source,
                sourceLabel: SOURCE_LABEL[p.source] ?? p.source,
                tag: p.tag,
                url: `/api/games/${game.id}/speakers/portrait/${encodeURIComponent(variable)}`,
            };
        }
        return { portraits };
    });

    const serve = (req, res, game, hit) => {
        // The picture always comes from inside the game folder or this game's work directory.
        const roots = [path.resolve(game.path), path.resolve(game.workDir)];
        if (!roots.some((root) => hit.file === root || hit.file.startsWith(root + path.sep))) {
            throw new HttpError(400, "路径无效", "bad_path");
        }
        sendFile(req, res, hit.file);
    };

    router.get("/api/games/:id/speakers/portrait/:variable", ({ req, res, params }) => {
        const game = games.get(params.id);
        const hit = resolvePortraits(game, speakersOf(game)).get(params.variable);
        if (!hit) throw new HttpError(404, "没有找到这个说话人的立绘", "no_portrait");
        serve(req, res, game, hit);
    });
}
