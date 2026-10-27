// Facts the other steps do not own: the text markup inside dialogue, what runs on top of a sprite,
// the transitions, the window/NVL statements, the achievements and the persistent flags.
//
// Everything here is counted, never interpreted: a `{size=30}` in a line is a fact about the
// original, and what it becomes in NarraLeaf is not this file's business.

import { byLocation } from "./screens.js";

const TOP = 40;
const SAMPLES = 5;
// A transform argument this big is a repeat count nobody waits out, not a coordinate.
const LONG_LOOP = 9999;

function tally(rows, key) {
    const map = new Map();
    for (const r of rows) {
        const k = typeof key === "function" ? key(r) : r[key];
        if (k == null) continue;
        const row = map.get(k) ?? { name: String(k), count: 0, sites: [] };
        row.count++;
        if (row.sites.length < SAMPLES && r.file) row.sites.push(`${r.file}:${r.line}`);
        map.set(k, row);
    }
    return [...map.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

/** Text tags and `[variable]` interpolations inside say statements. */
function textMarkup(says) {
    const tags = new Map();
    const vars = new Map();
    let taggedLines = 0;
    let interpolatedLines = 0;
    for (const s of says) {
        if (s.textTags?.length) {
            taggedLines++;
            for (const t of s.textTags) {
                const row = tags.get(t) ?? { name: t, count: 0, sites: [] };
                row.count++;
                if (row.sites.length < SAMPLES) row.sites.push(`${s.file}:${s.line}`);
                tags.set(t, row);
            }
        }
        if (s.interpolations?.length) {
            interpolatedLines++;
            for (const v of s.interpolations) {
                const row = vars.get(v) ?? { name: v, count: 0, sites: [] };
                row.count++;
                if (row.sites.length < SAMPLES) row.sites.push(`${s.file}:${s.line}`);
                vars.set(v, row);
            }
        }
    }
    const sort = (m) => [...m.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
    return { taggedLines, interpolatedLines, tags: sort(tags).slice(0, TOP), interpolations: sort(vars).slice(0, TOP) };
}

/** Say lines that carry sprite attributes (`eileen happy sit "…"`): the line changes the sprite too. */
function attributedSays(says) {
    const rows = says.filter((s) => s.attributes?.length);
    const byAttribute = new Map();
    for (const s of rows) {
        for (const a of s.attributes) byAttribute.set(a, (byAttribute.get(a) || 0) + 1);
    }
    return {
        lines: rows.length,
        speakers: tally(rows, "speaker").slice(0, TOP),
        attributes: [...byAttribute.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
            .slice(0, TOP).map(([name, count]) => ({ name, count })),
        samples: rows.slice(0, SAMPLES).map((s) => ({ file: s.file, line: s.line, speaker: s.speaker, attributes: s.attributes })),
    };
}

/** The first string literal in a line, which is how a call's name argument is read back. */
function firstString(text) {
    return /["']([^"']+)["']/.exec(String(text ?? ""))?.[1] ?? null;
}

/**
 * Achievements, through one level of wrapper. A game that writes `grant_achievement(name)` around
 * `achievement.grant` has its unlock points at the wrapper's call sites, not at the one line
 * inside the wrapper.
 */
function achievements(col) {
    const entries = col.pyEntries;
    const wrappers = new Set();
    for (const d of entries.filter((e) => e.kind === "def" && e.name)) {
        const body = entries.filter((e) => e.func === d.name && e.file === d.file);
        if (body.some((e) => e.api === "achievement.grant")) wrappers.add(d.name);
    }
    const grants = new Map();
    const note = (name, site, via) => {
        const key = name ?? "（名字不是字面量）";
        const row = grants.get(key) ?? { name: key, grants: 0, sites: [], via: new Set() };
        row.grants++;
        if (row.sites.length < SAMPLES) row.sites.push(site);
        row.via.add(via);
        grants.set(key, row);
    };
    for (const e of entries) {
        const site = `${e.file}:${e.line}`;
        if (e.api === "achievement.grant" && !e.func) note(firstString(e.snippet), site, "achievement.grant");
        else if ((e.kind === "customCall" || e.kind === "unknownCall") && wrappers.has(e.callee)) note(firstString(e.snippet), site, e.callee);
    }
    const declared = entries.filter((e) => e.api === "achievement.register")
        .map((e) => ({
            name: firstString(e.snippet), file: e.file, line: e.line,
            // `achievement.register("NEW_1_3", steam="NEW_ACHIEVEMENT_1_3")`: the Steam side has
            // its own id, and that is the one the store shows.
            steam: /steam\s*=\s*["']([^"']+)["']/.exec(String(e.snippet ?? ""))?.[1] ?? null,
        }));
    const steamOf = new Map(declared.filter((d) => d.name && d.steam).map((d) => [d.name, d.steam]));
    return {
        wrappers: [...wrappers],
        declared,
        unlockPoints: unlockPoints(col, entries, steamOf),
        granted: [...grants.values()]
            .map((r) => ({ ...r, via: [...r.via] }))
            .sort((a, b) => b.grants - a.grants || a.name.localeCompare(b.name)),
    };
}

/** The parameter names of `label achievement(who, n=1)`. */
function labelParams(text) {
    return String(text ?? "").replace(/^\(|\)$/g, "").split(",")
        .map((p) => p.trim().split("=")[0].trim()).filter((p) => /^\w+$/.test(p));
}

/**
 * Where the player actually unlocks each achievement. A game that writes one
 * `label achievement(who)` with an if-chain inside has its unlock points at the `call` sites, not
 * at the `achievement.grant` line, and the argument is what says which achievement each one is.
 */
/**
 * The `if` conditions a python line sits under. Inside a `python:` block the branches are python,
 * not Ren'Py statements, so they are reconstructed from indentation: walking back up the file,
 * each `if`/`elif` at a smaller indent than the last one is one more condition around this line.
 */
function pythonGuards(byFile, e) {
    const rows = byFile.get(e.file) ?? [];
    const out = [];
    let indent = e.indent ?? 0;
    for (let i = rows.indexOf(e) - 1; i >= 0 && indent > 0; i--) {
        const r = rows[i];
        if ((r.indent ?? 0) >= indent) continue;
        if (r.kind === "control" && /^(if|elif)\b/.test(String(r.snippet ?? ""))) out.push(r.snippet);
        indent = r.indent ?? 0;
    }
    return out;
}

function unlockPoints(col, entries, steamOf) {
    const paramsOf = new Map();
    for (const l of col.labels) if (l.parameters) paramsOf.set(l.name, labelParams(l.parameters));
    const byFile = new Map();
    for (const e of entries) {
        if (!byFile.has(e.file)) byFile.set(e.file, []);
        byFile.get(e.file).push(e);
    }
    for (const list of byFile.values()) list.sort((a, b) => a.line - b.line);
    const guardsOf = (e) => ((e.guards ?? []).length ? e.guards : pythonGuards(byFile, e));

    // Which parameter values a guarded branch in this label already claims, so an unguarded
    // `else` branch is not credited to a call site another branch answers.
    const claimed = new Map();
    for (const e of entries) {
        if (e.api !== "achievement.grant" || !e.label) continue;
        for (const g of guardsOf(e)) {
            const m = /(\w+)\s*==\s*["']?([\w.-]+)["']?/.exec(g);
            if (m) claimed.set(`${e.label} ${m[1]} ${m[2]}`, true);
        }
    }
    const rows = [];
    for (const e of entries) {
        if (e.api !== "achievement.grant" || !e.label) continue;
        const params = paramsOf.get(e.label);
        const calls = col.edges.filter((x) => x.to === e.label && (x.kind === "call" || x.kind === "renpy.call" || x.kind === "Call()"));
        if (!params?.length || !calls.length) continue;
        const name = firstString(e.snippet);
        // The equalities this grant sits under, as parameter → value.
        const wanted = new Map();
        let opaque = false;
        for (const g of guardsOf(e)) {
            const m = /(\w+)\s*==\s*["']?([\w.-]+)["']?/.exec(g);
            if (m && params.includes(m[1])) wanted.set(m[1], m[2]);
            else if (/^(if|elif|while)\b/.test(g)) opaque = true;
        }
        for (const c of calls) {
            const values = c.argumentValues ?? [];
            const bound = new Map(params.map((p, i) => [p, values[i]]));
            let matches = true;
            for (const [p, v] of wanted) if (String(bound.get(p)) !== String(v)) matches = false;
            // An unguarded grant is the `else`: it only runs for arguments no branch claims.
            if (matches && !wanted.size) {
                matches = ![...bound].some(([p, v]) => claimed.has(`${e.label} ${p} ${v}`));
            }
            if (!matches) continue;
            rows.push({
                name: name ?? "（名字不是字面量）", steam: steamOf.get(name) ?? null,
                site: `${c.file}:${c.line}`, label: e.label,
                arguments: c.arguments ?? null,
                grantedAt: `${e.file}:${e.line}`,
                certain: !opaque && wanted.size > 0 && values.length > 0,
                branch: wanted.size ? [...wanted].map(([p, v]) => `${p} == ${v}`).join(" 且 ") : "其它（else）",
            });
        }
    }
    return rows.sort((a, b) => a.name.localeCompare(b.name) || a.site.localeCompare(b.site));
}

/** `show x at t(9999)`: a transform whose argument is big enough to be a loop that never ends. */
function transforms(atClauses) {
    const rows = tally(atClauses, "transform");
    const longLoops = atClauses
        .filter((a) => a.numbers.some((n) => n >= LONG_LOOP))
        .map((a) => ({ transform: a.transform, tag: a.tag, arguments: a.arguments, file: a.file, line: a.line, label: a.label }))
        .sort(byLocation);
    return { used: rows.slice(0, TOP), total: atClauses.length, longLoops: longLoops.slice(0, TOP), longLoopCount: longLoops.length };
}

export function buildFacts(col) {
    const says = col.says;
    const markup = textMarkup(says);
    const ach = achievements(col);
    const audioByChannel = tally(col.audio, (a) => `${a.statement} ${a.channel ?? "—"}`);
    const distinctAudio = new Set(col.audio.map((a) => a.audio).filter(Boolean));

    return {
        version: 1,
        summary: {
            textTagLines: markup.taggedLines,
            textTagKinds: markup.tags.length,
            interpolatedLines: markup.interpolatedLines,
            extendLines: says.filter((s) => s.kind === "extend").length,
            attributedSays: says.filter((s) => s.attributes?.length).length,
            windowStatements: col.windowStatements.length,
            nvlStatements: col.nvlStatements.length,
            pauses: col.pauses.length,
            transitions: col.transitions.length,
            atClauses: col.atClauses.length,
            longLoops: col.atClauses.filter((a) => a.numbers.some((n) => n >= LONG_LOOP)).length,
            achievements: ach.declared.length,
            achievementUnlocks: ach.granted.reduce((n, a) => n + a.grants, 0),
            achievementUnlockPoints: ach.unlockPoints.length,
            audioStatements: col.audio.length,
            audioFiles: distinctAudio.size,
        },
        textTags: markup.tags,
        interpolations: markup.interpolations,
        attributedSays: attributedSays(says),
        transitions: tally(col.transitions, "name").slice(0, TOP),
        transforms: transforms(col.atClauses),
        window: tally(col.windowStatements, (w) => w.action || "window"),
        nvl: tally(col.nvlStatements, (n) => n.action || "nvl"),
        audio: audioByChannel,
        achievements: ach,
        pauses: {
            total: col.pauses.length,
            withoutSeconds: col.pauses.filter((p) => p.seconds === null).length,
            longest: col.pauses.reduce((n, p) => Math.max(n, p.seconds ?? 0), 0),
        },
    };
}
