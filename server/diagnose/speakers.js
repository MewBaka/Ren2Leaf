// Step ③ speakers: every Character variable with the evidence a migrator needs to decide who it is
// — line count, sample lines, the sprite tags on stage, and above all the folder of the `voice`
// line before each say, which is the hardest evidence that two variables are the same person.
//
// One variable can cover several people (a `？？？` placeholder reused across a game), so the
// output is not a flat variable → person map: each speaker also carries line ranges, split where
// the voice folder changes, and a decision can be made per range.

import { byLocation } from "./screens.js";

const SAMPLE_COUNT = 3;
const SAMPLE_CHARS = 90;
const TOP_TAGS = 8;
const PLACEHOLDER = /^[\s?？・.。・…\-—_*＊「」『』]*$/;
// The last number in a voice file name is the take number. One voice actor's takes usually run
// as a single series across a game, so two variables sharing a run of numbers are one person.
const TAKE_IN_PARENS = /\((\d+)\)/g;
const TAKE_TRAILING = /(\d+)\D*$/;
const DOMINANT = 0.8;
const DOMINANT_MIN = 3;     // below this, one stray voice line is not evidence of anything

const counted = (map, cap = Infinity) =>
    [...map.entries()].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0]))).slice(0, cap);

function bump(map, key) {
    if (key == null) return;
    map.set(key, (map.get(key) || 0) + 1);
}

function takeNumber(file) {
    const base = (String(file ?? "").replace(/\\/g, "/").split("/").pop() ?? "").replace(/\.[a-z0-9]+$/i, "");
    // `vo_q(6)-2.mp3` is take 6 recorded twice, not take 2, so a number in brackets wins.
    const paren = [...base.matchAll(TAKE_IN_PARENS)].pop();
    if (paren) return Number(paren[1]);
    const m = TAKE_TRAILING.exec(base);
    return m ? Number(m[1]) : null;
}

/** Collects the voice folders a set of lines uses, with the take numbers seen in each. */
function voiceUse(says) {
    const dirs = new Map();
    for (const s of says) {
        if (!s.voiceDir) continue;
        const row = dirs.get(s.voiceDir) ?? { dir: s.voiceDir, lines: 0, from: null, to: null };
        row.lines++;
        const n = takeNumber(s.voice);
        if (n !== null) {
            row.from = row.from === null ? n : Math.min(row.from, n);
            row.to = row.to === null ? n : Math.max(row.to, n);
        }
        dirs.set(s.voiceDir, row);
    }
    return [...dirs.values()].sort((a, b) => b.lines - a.lines || a.dir.localeCompare(b.dir));
}

/**
 * Splits one variable's lines into ranges, starting a new one at a file change or where the voice
 * folder changes. Lines with no voice join the range they fall in.
 */
function rangesFor(says) {
    const out = [];
    let cur = null;
    for (const s of says) {
        const dir = s.voiceDir || null;
        if (!cur || cur.file !== s.file || (dir && cur.voiceDir && dir !== cur.voiceDir)) {
            cur = { file: s.file, startLine: s.line, endLine: s.line, lines: 0, voiceDir: dir, voiced: 0, says: [], spriteTags: new Map() };
            out.push(cur);
        }
        if (dir && !cur.voiceDir) cur.voiceDir = dir;
        cur.endLine = Math.max(cur.endLine, s.endLine || s.line);
        cur.lines++;
        cur.says.push(s);
        if (dir) cur.voiced++;
        bump(cur.spriteTags, s.sprite);
    }
    return out.map((r) => ({
        file: r.file, startLine: r.startLine, endLine: r.endLine, lines: r.lines,
        voiceDir: r.voiceDir, voiced: r.voiced,
        voiceDirs: voiceUse(r.says),
        spriteTags: counted(r.spriteTags, 3).map(([tag]) => tag),
    }));
}

function evidence(says) {
    const files = new Map();
    const spriteTags = new Map();
    const attributes = new Map();
    let voiced = 0;
    for (const s of says) {
        bump(files, s.file);
        bump(spriteTags, s.sprite);
        for (const a of s.attributes || []) bump(attributes, a);
        if (s.voiceDir) voiced++;
    }
    const samples = says.slice(0, SAMPLE_COUNT).map((s) => ({
        file: s.file, line: s.line,
        text: (s.text ?? "").length > SAMPLE_CHARS ? `${(s.text ?? "").slice(0, SAMPLE_CHARS - 1)}…` : s.text ?? "",
        voice: s.voice ?? null,
    }));
    return {
        lines: says.length,
        voiced,
        files: counted(files).map(([file, lines]) => ({ file, lines })),
        voiceDirs: voiceUse(says),
        spriteTags: counted(spriteTags, TOP_TAGS).map(([tag, lines]) => ({ tag, lines })),
        attributes: counted(attributes, TOP_TAGS).map(([name, lines]) => ({ name, lines })),
        samples,
        ranges: rangesFor(says),
    };
}

/** The voice folder that most of a speaker's voiced lines come from, when there is one. */
function dominantVoice(voiceDirs, voiced) {
    if (voiced < DOMINANT_MIN || !voiceDirs.length) return null;
    const top = voiceDirs[0];
    return top.lines / voiced >= DOMINANT ? { dir: top.dir, share: Math.round((top.lines / voiced) * 100) } : null;
}

function flagsFor(sp, nameCounts, totalLines) {
    const flags = [];
    const name = sp.displayName;
    if (!sp.lines) flags.push({ kind: "unused", message: "已定义但无台词" });
    if (sp.nameExpression) flags.push({ kind: "interpolatedName", message: `显示名为表达式 ${sp.nameExpression}，运行时才能确定` });
    else if (name === "") {
        // `Character("")` has a name box with nothing in it: in practice a text style (black
        // screen, centred text), spoken by whoever the voice line belongs to.
        flags.push({
            kind: "narratorStyle",
            message: sp.voiceDirs.length
                ? `显示名为空字符串（Character("")），表示文本样式而非角色；这些行含配音，实际说话者为 ${sp.voiceDirs.slice(0, 4).map((v) => `${v.dir}×${v.lines}`).join("、")} 对应的角色`
                : '显示名为空字符串（Character("")），表示文本样式而非角色',
        });
    } else if (name == null && sp.declared) flags.push({ kind: "noName", message: "无显示名，疑似旁白或内心独白" });
    else if (name != null && PLACEHOLDER.test(name)) flags.push({ kind: "placeholderName", message: `显示名「${name}」为占位符，可能对应多个角色` });
    if (name && nameCounts.get(name) > 1) flags.push({ kind: "duplicateName", message: `与另外 ${nameCounts.get(name) - 1} 个变量同名，可能为同一角色的不同立绘` });
    if (sp.voiceDirs.length > 1) {
        flags.push({
            kind: "mixedVoiceDirs",
            message: `配音来自 ${sp.voiceDirs.length} 个目录（${sp.voiceDirs.slice(0, 4).map((v) => `${v.dir}×${v.lines}`).join("、")}），可能对应多个角色`,
        });
    }
    if (!sp.declared) flags.push({ kind: "undeclared", message: "有台词但未找到 Character 定义，可能位于 .rpyc 中或为动态生成" });
    if (sp.lines && !sp.voiced) flags.push({ kind: "noVoice", message: "无 voice 语句，角色身份仅可通过立绘与台词推断" });
    if (sp.lines && totalLines && sp.lines / totalLines >= 0.05) flags.push({ kind: "major", message: `占全部台词的 ${Math.round((sp.lines / totalLines) * 100)}%` });
    return flags;
}

/**
 * Builds the speakers section.
 * @param {object} col the collector after the scan
 * @param {Array} characters the resolved character list from the inventory
 */
export function buildSpeakers(col, characters) {
    const says = col.says;
    const byVariable = new Map();
    for (const s of says) {
        if (s.kind === "narrator" || s.kind === "inline" || !s.speaker) continue;
        if (!byVariable.has(s.speaker)) byVariable.set(s.speaker, []);
        byVariable.get(s.speaker).push(s);
    }
    for (const list of byVariable.values()) list.sort(byLocation);

    const declared = new Map();
    for (const c of characters) if (!declared.has(c.variable)) declared.set(c.variable, c);

    const nameCounts = new Map();
    const sharingName = new Map();
    for (const c of characters) {
        if (c.displayName == null || PLACEHOLDER.test(c.displayName)) continue;
        bump(nameCounts, c.displayName);
        if (!sharingName.has(c.displayName)) sharingName.set(c.displayName, []);
        if (!sharingName.get(c.displayName).includes(c.variable)) sharingName.get(c.displayName).push(c.variable);
    }

    const names = new Set([...declared.keys(), ...byVariable.keys()]);
    const totalSpoken = says.filter((s) => s.speaker).length;

    const speakers = [];
    for (const variable of names) {
        const c = declared.get(variable) || null;
        const list = byVariable.get(variable) || [];
        const ev = evidence(list);
        const sp = {
            variable,
            declared: !!c,
            constructor: c?.constructor ?? null,
            displayName: c ? c.displayName : null,
            nameExpression: c?.nameExpression ?? null,
            kind: c?.kind ?? null,
            image: c?.image ?? null,
            screen: c?.screen ?? null,
            file: c?.file ?? list[0]?.file ?? null,
            line: c?.line ?? list[0]?.line ?? null,
            ...ev,
        };
        sp.dominantVoice = dominantVoice(sp.voiceDirs, sp.voiced);
        sp.flags = flagsFor(sp, nameCounts, totalSpoken);
        sp.sameName = (sharingName.get(sp.displayName) ?? []).filter((v) => v !== variable);
        speakers.push(sp);
    }
    speakers.sort((a, b) => b.lines - a.lines || a.variable.localeCompare(b.variable));

    // Same display name, several variables: usually one person with several sprite sets.
    const groups = [];
    for (const [name, count] of nameCounts) {
        if (count < 2) continue;
        const members = speakers.filter((s) => s.displayName === name);
        groups.push({
            displayName: name,
            variables: members.map((s) => ({ variable: s.variable, lines: s.lines, voiceDirs: s.voiceDirs.map((v) => v.dir) })),
            lines: members.reduce((n, s) => n + s.lines, 0),
            sameVoice: new Set(members.flatMap((s) => s.voiceDirs.map((v) => v.dir))).size <= 1,
        });
    }
    groups.sort((a, b) => b.lines - a.lines);

    // voice folder -> which variables speak from it. A folder shared by several variables is
    // either an alias or one person with several sprite sets.
    const dirs = new Map();
    for (const s of speakers) {
        for (const v of s.voiceDirs) {
            const row = dirs.get(v.dir) ?? { dir: v.dir, lines: 0, variables: [] };
            row.lines += v.lines;
            row.variables.push({ variable: s.variable, displayName: s.displayName, lines: v.lines, from: v.from, to: v.to });
            dirs.set(v.dir, row);
        }
    }
    const voiceDirs = [...dirs.values()].sort((a, b) => b.lines - a.lines);
    for (const d of voiceDirs) d.variables.sort((a, b) => b.lines - a.lines);

    const inline = new Map();
    for (const s of says) {
        if (s.kind !== "inline" || !s.inlineName) continue;
        const row = inline.get(s.inlineName) ?? { name: s.inlineName, lines: 0, files: new Map(), samples: [] };
        row.lines++;
        bump(row.files, s.file);
        if (row.samples.length < SAMPLE_COUNT) row.samples.push({ file: s.file, line: s.line, text: s.text ?? "" });
        inline.set(s.inlineName, row);
    }
    const inlineSpeakers = [...inline.values()]
        .map((r) => ({ name: r.name, lines: r.lines, files: counted(r.files).map(([file, lines]) => ({ file, lines })), samples: r.samples }))
        .sort((a, b) => b.lines - a.lines);

    const narratorSays = says.filter((s) => s.kind === "narrator");
    const narratorFiles = new Map();
    for (const s of narratorSays) bump(narratorFiles, s.file);
    const needsDecision = speakers.filter((s) => s.lines > 0).length;

    return {
        version: 1,
        summary: {
            speakers: speakers.length,
            withLines: speakers.filter((s) => s.lines).length,
            unused: speakers.filter((s) => !s.lines).length,
            placeholderNames: speakers.filter((s) => s.flags.some((f) => f.kind === "placeholderName")).length,
            narratorStyle: speakers.filter((s) => s.flags.some((f) => f.kind === "narratorStyle")).length,
            mixedVoiceDirs: speakers.filter((s) => s.flags.some((f) => f.kind === "mixedVoiceDirs")).length,
            mergeCandidates: groups.length,
            undeclared: speakers.filter((s) => !s.declared).length,
            inlineSpeakers: inlineSpeakers.length,
            needsDecision,
            sayLines: says.length,
            spokenLines: totalSpoken,
            narratorLines: narratorSays.length,
            extendLines: says.filter((s) => s.kind === "extend").length,
            voicedLines: says.filter((s) => s.voice).length,
            voiceDirs: voiceDirs.length,
            nvlLines: says.filter((s) => s.nvl).length,
        },
        speakers,
        groups,
        voiceDirs,
        inlineSpeakers,
        narrator: {
            lines: narratorSays.length,
            files: counted(narratorFiles).map(([file, lines]) => ({ file, lines })),
            samples: narratorSays.slice(0, SAMPLE_COUNT).map((s) => ({ file: s.file, line: s.line, text: (s.text ?? "").slice(0, SAMPLE_CHARS) })),
        },
    };
}
