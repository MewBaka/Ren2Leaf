// The migrator's own answers, kept apart from anything the scanner writes:
//   <work>/decisions/speakers.json   who each Character variable is
//   <work>/decisions/chapters.json   which script file belongs to which chapter
// A re-scan never touches these files, and a speaker write merges field by field, keyed by the
// Ren'Py variable name, so re-scanning a game can never lose what somebody filled in.

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { HttpError, readJson } from "./http.js";

export const DECISIONS_VERSION = 1;

/**
 * What a speaker becomes in NarraLeaf. A voice take can only be linked to a character that exists,
 * so anything voiced has to be a character — which is why an alias is its own character here (in a
 * group, to keep the character list readable) rather than a `/rename` on somebody else.
 *   main     角色栏顶层
 *   npc      角色栏的 NPC / 别名分组
 *   temp     不建角色，名字直接写在台词里
 *   pov      视角角色，顶层，只是标出来
 *   agent    迁移者定不了，交给 Agent 判断；必须带 note，写明迁移者看到了什么、拿不准什么
 *   removed  迁移者把它从名单里拿掉了（调试用的、根本不出场的），报告里不再提
 */
const ROLES = new Set(["main", "npc", "temp", "pov", "agent", "removed"]);
const VARIABLE = /^[A-Za-z_]\w{0,63}$/;
const TEXT_MAX = 400;

const empty = () => ({ version: DECISIONS_VERSION, updatedAt: null, speakers: {} });

export function decisionsFile(workDir) {
    return path.join(workDir, "decisions", "speakers.json");
}

export function chaptersFile(workDir) {
    return path.join(workDir, "decisions", "chapters.json");
}

export function documentFile(workDir) {
    return path.join(workDir, "decisions", "document.json");
}

/**
 * Which steps put their findings in the package. A step the migrator switches off is not missing
 * data: the document says the call was left to the agent, which then reads the source itself.
 */
export const DOCUMENT_STEPS = ["diagnose", "capture", "speakers", "flow"];

const emptyDocument = () => ({ version: 1, updatedAt: null, skip: {} });

export function readDocument(workDir) {
    let data;
    try {
        data = JSON.parse(fs.readFileSync(documentFile(workDir), "utf8"));
    } catch {
        return emptyDocument();
    }
    if (!data || typeof data !== "object" || typeof data.skip !== "object" || !data.skip) return emptyDocument();
    const skip = {};
    for (const step of DOCUMENT_STEPS) if (data.skip[step] === true) skip[step] = true;
    return { version: data.version ?? 1, updatedAt: data.updatedAt ?? null, skip };
}

/** Merges a patch of `{step: boolean}`; true means "leave this to the agent". */
export function mergeDocument(doc, patch) {
    if (!patch || typeof patch !== "object" || typeof patch.skip !== "object" || !patch.skip) {
        throw new HttpError(400, "需要 skip 对象", "bad_patch");
    }
    const skip = { ...doc.skip };
    for (const [step, value] of Object.entries(patch.skip)) {
        if (!DOCUMENT_STEPS.includes(step)) throw new HttpError(400, `未知的步骤：${step}`, "unknown_step");
        if (typeof value !== "boolean" && value !== null) throw new HttpError(400, "值必须是 true 或 false", "bad_value");
        if (value === true) skip[step] = true;
        else delete skip[step];
    }
    return { version: 1, updatedAt: new Date().toISOString(), skip };
}

export function readDecisions(workDir) {
    let data;
    try {
        data = JSON.parse(fs.readFileSync(decisionsFile(workDir), "utf8"));
    } catch {
        return empty();
    }
    if (!data || typeof data !== "object" || typeof data.speakers !== "object" || !data.speakers) return empty();
    return { version: data.version ?? DECISIONS_VERSION, updatedAt: data.updatedAt ?? null, speakers: data.speakers };
}

async function writeDoc(file, doc) {
    await fsp.mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    await fsp.writeFile(tmp, `${JSON.stringify(doc, null, 2)}\n`);
    await fsp.rename(tmp, file);
}

function text(value, what) {
    if (value === null || value === undefined || value === "") return null;
    if (typeof value !== "string") throw new HttpError(400, `${what} 必须是文本`, "bad_value");
    const s = value.trim();
    if (!s) return null;
    if (s.length > TEXT_MAX) throw new HttpError(400, `${what} 过长`, "too_long");
    return s;
}

function role(value) {
    if (value === null || value === undefined || value === "") return null;
    if (typeof value !== "string" || !ROLES.has(value)) throw new HttpError(400, "角色类型无效", "bad_role");
    return value;
}

const FIELDS = ["role", "name", "note", "mergeInto"];

/**
 * Merges `patch` into `doc`. A field that is not in the patch keeps its stored value; a field sent
 * as null or "" is cleared. An entry with nothing left in it is removed.
 * @returns {{doc: object, changed: string[]}}
 */
export function mergeDecisions(doc, patch) {
    if (!patch || typeof patch !== "object" || typeof patch.speakers !== "object" || !patch.speakers) {
        throw new HttpError(400, "需要 speakers 对象", "bad_patch");
    }
    const next = { version: DECISIONS_VERSION, updatedAt: new Date().toISOString(), speakers: { ...doc.speakers } };
    const changed = [];
    for (const [variable, raw] of Object.entries(patch.speakers)) {
        if (!VARIABLE.test(variable)) throw new HttpError(400, `变量名无效：${variable}`, "bad_variable");
        if (raw === null) {
            delete next.speakers[variable];
            changed.push(variable);
            continue;
        }
        if (typeof raw !== "object") throw new HttpError(400, "填写内容格式无效", "bad_entry");
        for (const key of Object.keys(raw)) {
            if (!FIELDS.includes(key)) throw new HttpError(400, `未知字段：${key}`, "unknown_field");
        }
        // `updatedAt` is bookkeeping, not an answer: it must not keep an emptied entry alive.
        const { updatedAt: _was, ...prev } = next.speakers[variable] ?? {};
        const entry = { ...prev };
        if ("role" in raw) entry.role = role(raw.role);
        for (const key of FIELDS.filter((f) => f !== "role")) {
            if (key in raw) entry[key] = text(raw[key], key === "name" ? "角色名" : "内容");
        }
        for (const key of Object.keys(entry)) {
            if (entry[key] === null || (Array.isArray(entry[key]) && !entry[key].length)) delete entry[key];
        }
        // The agent gets the call only with the migrator's reasons: without them it is just unsorted.
        if (entry.role === "agent" && !entry.note) {
            throw new HttpError(400, `${variable} 交给 Agent 判断时需要填写备注`, "note_required");
        }
        if (!Object.keys(entry).length) delete next.speakers[variable];
        else next.speakers[variable] = { ...entry, updatedAt: new Date().toISOString() };
        changed.push(variable);
    }
    return { doc: next, changed };
}

// ------------------------------------------------------------------ chapters

export const SPLIT_MODES = new Set(["none", "choices", "full"]);
const CHAPTER_MAX = 200;
const FILES_MAX = 2000;

const emptyChapters = () => ({ version: 1, updatedAt: null, mode: null, chapters: [], excluded: [] });

export function readChapters(workDir) {
    let data;
    try {
        data = JSON.parse(fs.readFileSync(chaptersFile(workDir), "utf8"));
    } catch {
        return emptyChapters();
    }
    if (!data || typeof data !== "object" || !Array.isArray(data.chapters)) return emptyChapters();
    return {
        version: data.version ?? 1,
        updatedAt: data.updatedAt ?? null,
        mode: SPLIT_MODES.has(data.mode) ? data.mode : null,
        chapters: data.chapters,
        // Files the migrator says are not story at all (interface, transforms, debug leftovers).
        excluded: Array.isArray(data.excluded) ? data.excluded.filter((f) => typeof f === "string") : [],
    };
}

/**
 * Validates a whole chapter plan. A file may sit in one chapter only, and a file the migrator
 * excluded is in no chapter; everything else — how many chapters there are, what they are called,
 * which file goes where — is the migrator's call.
 */
export function cleanChapters(patch) {
    if (!patch || typeof patch !== "object") throw new HttpError(400, "章节格式无效", "bad_chapters");
    if (patch.mode !== null && patch.mode !== undefined && !SPLIT_MODES.has(patch.mode)) {
        throw new HttpError(400, "拆分方式无效", "bad_mode");
    }
    const list = patch.chapters ?? [];
    if (!Array.isArray(list)) throw new HttpError(400, "章节格式无效", "bad_chapters");
    if (list.length > CHAPTER_MAX) throw new HttpError(400, "章节过多", "too_many_chapters");
    const ids = new Set();
    const seenFiles = new Map();
    const chapters = [];
    let total = 0;
    for (const c of list) {
        const id = text(c?.id, "章节 id");
        const title = text(c?.title, "章节名");
        const label = title || `未命名 ${chapters.length + 1}`;
        if (!id || !/^[\w-]{1,64}$/.test(id)) throw new HttpError(400, "章节 id 无效", "bad_chapter_id");
        if (ids.has(id)) throw new HttpError(409, "章节 id 重复", "duplicate_chapter");
        ids.add(id);
        const files = [];
        for (const f of c?.files ?? []) {
            const file = text(f, "文件");
            if (!file) continue;
            if (file.includes("..") || path.isAbsolute(file)) throw new HttpError(400, `文件路径无效：${file}`, "bad_file");
            if (seenFiles.has(file)) throw new HttpError(409, `${file} 被分配至两个章节：${seenFiles.get(file)} 和 ${label}`, "file_in_two_chapters");
            seenFiles.set(file, label);
            files.push(file);
            total++;
            if (total > FILES_MAX) throw new HttpError(400, "文件过多", "too_many_files");
        }
        // Title and description are the migrator's words for the Studio scene this chapter becomes.
        // Left empty they stay empty: the agent is told not to make them up.
        chapters.push({
            id, title: title ?? "", description: text(c?.description, "描述") ?? undefined, files,
            note: text(c?.note, "备注") ?? undefined,
        });
    }
    const excluded = [];
    for (const f of patch.excluded ?? []) {
        const file = text(f, "文件");
        if (!file) continue;
        if (file.includes("..") || path.isAbsolute(file)) throw new HttpError(400, `文件路径无效：${file}`, "bad_file");
        if (seenFiles.has(file)) throw new HttpError(409, `${file} 已分配至「${seenFiles.get(file)}」，不能同时排除`, "excluded_in_chapter");
        if (!excluded.includes(file)) excluded.push(file);
        if (excluded.length > FILES_MAX) throw new HttpError(400, "文件过多", "too_many_files");
    }
    return { version: 1, updatedAt: new Date().toISOString(), mode: patch.mode ?? null, chapters, excluded };
}

/**
 * Contradictions between the chapter plan and what the scan found. These are not refusals: the
 * grouping is the migrator's call, and this only says what looks inconsistent so nothing silently
 * ships as a chapter with no dialogue in it.
 * @param {object} doc the chapter plan
 * @param {Array} files `flow.files` from the inventory
 */
/** What a chapter is called on screen: its title, or its place in the list when it has none. */
export function chapterLabel(chapter, index) {
    return chapter.title || `未命名 ${index + 1}`;
}

export function chapterIssues(doc, files = []) {
    const chapters = doc?.chapters ?? [];
    if (!chapters.length && !(doc?.excluded ?? []).length) return [];
    const byFile = new Map((files ?? []).map((f) => [f.file, f]));
    const excluded = new Set(doc?.excluded ?? []);
    const issues = [];
    for (const f of excluded) {
        const row = byFile.get(f);
        if (!row) continue;
        if (row.says) {
            issues.push({ kind: "excludedWithDialogue", chapter: null, message: `${f} 已被排除，但包含 ${row.says} 句台词` });
        }
        // A file play actually walks into is part of the story whatever it is called: the credits
        // a good ending jumps to live in their own file, and dropping it loses the ending.
        const entered = (row.enteredFrom ?? []).filter((e) => e.reachable && e.from.some((x) => !excluded.has(x.file)));
        if (entered.length) {
            const where = entered.slice(0, 3).map((e) => `${e.label}（${e.from.map((x) => `${x.file}:${x.line}`).join("、")}）`).join("；");
            issues.push({
                kind: "excludedButEntered", chapter: null,
                message: `${f} 已被排除，但存在从其他文件跳转至该文件的入口：${where}。导出前请确认该文件不属于剧本内容（如片尾、回忆、结局等）`,
            });
        }
        if (row.endings) {
            issues.push({ kind: "excludedWithEnding", chapter: null, message: `${f} 已被排除，但包含 ${row.endings} 个结局` });
        }
    }
    for (const [i, c] of chapters.entries()) {
        const name = chapterLabel(c, i);
        const rows = c.files.map((f) => byFile.get(f) ?? null);
        const missing = c.files.filter((f) => !byFile.has(f));
        const says = rows.reduce((n, r) => n + (r?.says ?? 0), 0);
        const unreachable = c.files.filter((f) => byFile.get(f) && byFile.get(f).playOrder === null);
        if (!c.files.length) issues.push({ kind: "emptyChapter", chapter: name, message: `章节「${name}」中未包含任何文件` });
        else if (!says) issues.push({ kind: "chapterWithoutDialogue", chapter: name, message: `章节「${name}」中无台词内容（${c.files.join("、")}）` });
        if (missing.length) issues.push({ kind: "fileNotInScan", chapter: name, message: `章节「${name}」中的 ${missing.join("、")} 未出现在扫描结果中，可能是重新扫描后文件已重命名` });
        if (unreachable.length) issues.push({ kind: "unreachableFile", chapter: name, message: `章节「${name}」中的 ${unreachable.join("、")} 从入口不可达，可能是测试稿或废弃内容` });
    }
    if (doc.mode === "none" && chapters.length > 1) {
        issues.push({ kind: "modeConflict", chapter: null, message: `拆分方式为「不拆分」，但实际划分了 ${chapters.length} 个章节` });
    }
    if (doc.mode === "full") {
        const many = chapters.filter((c) => c.files.length > 1);
        if (many.length) issues.push({ kind: "modeNote", chapter: null, message: `拆分方式为「全拆分」，但有 ${many.length} 个章节包含多个文件（全拆分是一个文件做成一个场景，请确认不是漏拆）` });
    }
    return issues;
}

export function chapterStats(doc) {
    return {
        chapters: doc.chapters.length,
        files: doc.chapters.reduce((n, c) => n + c.files.length, 0),
        excluded: (doc.excluded ?? []).length,
        mode: doc.mode,
        updatedAt: doc.updatedAt,
    };
}

/** How much of the work is done, for the step header and the final report. */
export function decisionStats(doc) {
    const entries = Object.values(doc.speakers ?? {});
    return {
        filled: entries.length,
        named: entries.filter((e) => e.name).length,
        merged: entries.filter((e) => e.mergeInto).length,
        updatedAt: doc.updatedAt ?? null,
    };
}

export function register(router, { games }) {
    router.get("/api/games/:id/document/decisions", ({ params }) => {
        const game = games.get(params.id);
        return { document: readDocument(game.workDir), file: documentFile(game.workDir) };
    });

    router.put("/api/games/:id/document/decisions", async ({ req, params }) => {
        const game = games.get(params.id);
        const doc = mergeDocument(readDocument(game.workDir), await readJson(req));
        await writeDoc(documentFile(game.workDir), doc);
        return { document: doc, file: documentFile(game.workDir) };
    });

    router.get("/api/games/:id/speakers/decisions", ({ params }) => {
        const game = games.get(params.id);
        const doc = readDecisions(game.workDir);
        return { decisions: doc, stats: decisionStats(doc), file: decisionsFile(game.workDir) };
    });

    router.get("/api/games/:id/chapters/decisions", ({ params }) => {
        const game = games.get(params.id);
        const doc = readChapters(game.workDir);
        return { chapters: doc, stats: chapterStats(doc), file: chaptersFile(game.workDir) };
    });


    router.put("/api/games/:id/chapters/decisions", async ({ req, params }) => {
        const game = games.get(params.id);
        const body = await readJson(req);
        const doc = cleanChapters(body);
        await writeDoc(chaptersFile(game.workDir), doc);
        return { chapters: doc, stats: chapterStats(doc), file: chaptersFile(game.workDir) };
    });

    router.put("/api/games/:id/speakers/decisions", async ({ req, params }) => {
        const game = games.get(params.id);
        const patch = await readJson(req);
        const { doc, changed } = mergeDecisions(readDecisions(game.workDir), patch);
        await writeDoc(decisionsFile(game.workDir), doc);
        return { decisions: doc, stats: decisionStats(doc), changed, file: decisionsFile(game.workDir) };
    });
}
