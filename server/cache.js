// Clearing the work directory: ~/.ren2leaf/work/<id>/ fills up with a cloned game, its saves and
// its screenshots, and none of that is worth keeping forever.
//
// The split that matters is cache against answers. Everything the scanner or a run produced can be
// made again (re-scan, re-capture, re-export); what the migrator filled in by hand — speakers,
// chapters, which steps go into the package — cannot, so `decisions` is marked precious, is never
// part of a default sweep, and the UI has to ask for it by name.
//
// Nothing here deletes outside the work directory: a group is a fixed list of names under
// <work>/, and a run in progress blocks the sweep rather than having the floor pulled out from it.

import fs from "node:fs";
import path from "node:path";
import { HttpError, readJson } from "./http.js";
import { runs } from "./capture.js";

/**
 * The groups the UI offers, in the order it shows them: cheapest to lose first.
 * `entries` are names directly under the work directory, files or directories.
 */
export const CACHE_GROUPS = [
    {
        id: "runs",
        label: "运行临时文件",
        hint: "运行时复制的游戏副本、沙盒配置及其存档；截图已提取，删除不影响已有结果",
        entries: [
            "capture-run", "manual-run",
            "capture-saves", "manual-saves",
            "capture-sandbox.sb", "manual-sandbox.sb",
            "capture-job.json", "manual-job.json",
            ".DS_Store",
        ],
    },
    {
        id: "shots",
        label: "截图与切图",
        hint: "删除后需重新启动游戏并再次截图",
        entries: ["capture", "manual"],
    },
    {
        id: "scan",
        label: "诊断结果",
        hint: "inventory.json，重新诊断后将重新生成",
        entries: ["inventory.json"],
    },
    {
        id: "export",
        label: "导出的补充包",
        hint: "工作目录中的副本，重新导出即可；手动选择目录导出的版本不在此列",
        entries: ["export"],
    },
    {
        id: "decisions",
        label: "已配置的说话人与章节",
        hint: "此项非缓存：删除后需重新配置",
        entries: ["decisions"],
        precious: true,
    },
];

const GROUPS_BY_ID = new Map(CACHE_GROUPS.map((g) => [g.id, g]));

/** Bytes and file count of a file or directory. Symlinks count as themselves and are not followed. */
export function measure(target) {
    let stat;
    try {
        stat = fs.lstatSync(target);
    } catch {
        return { bytes: 0, files: 0, exists: false };
    }
    if (!stat.isDirectory()) return { bytes: stat.size, files: 1, exists: true };
    let bytes = 0;
    let files = 0;
    const walk = (dir) => {
        let entries;
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
            return;
        }
        for (const e of entries) {
            const p = path.join(dir, e.name);
            if (e.isDirectory()) {
                walk(p);
                continue;
            }
            try {
                bytes += fs.lstatSync(p).size;
                files++;
            } catch {
                // Vanished mid-walk; a run may still be writing.
            }
        }
    };
    walk(target);
    return { bytes, files, exists: true };
}

/** What each group currently takes up in `workDir`. */
export function surveyWorkDir(workDir) {
    const groups = CACHE_GROUPS.map((g) => {
        let bytes = 0;
        let files = 0;
        const present = [];
        for (const name of g.entries) {
            const m = measure(path.join(workDir, name));
            if (!m.exists) continue;
            bytes += m.bytes;
            files += m.files;
            present.push(name);
        }
        return { id: g.id, label: g.label, hint: g.hint, precious: Boolean(g.precious), bytes, files, present };
    });
    const total = measure(workDir);
    const known = groups.reduce((n, g) => n + g.bytes, 0);
    return { groups, bytes: total.bytes, files: total.files, other: Math.max(0, total.bytes - known) };
}

/** Removes the named groups from `workDir`. Returns what each one freed. */
export function clearGroups(workDir, ids) {
    if (!Array.isArray(ids) || !ids.length) throw new HttpError(400, "未选择要清理的内容", "nothing_selected");
    const wanted = [];
    for (const id of ids) {
        const group = GROUPS_BY_ID.get(String(id));
        if (!group) throw new HttpError(400, `未知的清理项 ${id}`, "bad_group");
        wanted.push(group);
    }
    const removed = [];
    let freed = 0;
    for (const group of wanted) {
        let bytes = 0;
        const names = [];
        for (const name of group.entries) {
            const target = path.join(workDir, name);
            const m = measure(target);
            if (!m.exists) continue;
            fs.rmSync(target, { recursive: true, force: true });
            bytes += m.bytes;
            names.push(name);
        }
        freed += bytes;
        removed.push({ id: group.id, label: group.label, bytes, entries: names });
    }
    return { removed, freed };
}

function assertIdle(gameId) {
    const run = runs.get(gameId);
    if (run && run.status === "running") {
        throw new HttpError(409, "游戏正在运行，请先结束当前会话再执行清理", "run_in_progress");
    }
}

function assertNothingRunning() {
    for (const run of runs.values()) {
        if (run && run.status === "running") {
            throw new HttpError(409, "有游戏正在运行，请先结束当前会话再执行清理", "run_in_progress");
        }
    }
}

/** Work directories under `home` that no listed game owns — left behind by a removed game. */
export function findOrphans(home, games) {
    const root = path.join(home, "work");
    const known = new Set(games.map((g) => g.id));
    let entries;
    try {
        entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
        return [];
    }
    const orphans = [];
    for (const e of entries) {
        if (!e.isDirectory() || !/^[0-9a-f]{10}$/.test(e.name) || known.has(e.name)) continue;
        const dir = path.join(root, e.name);
        const m = measure(dir);
        orphans.push({ id: e.name, dir, bytes: m.bytes, files: m.files });
    }
    return orphans.sort((a, b) => b.bytes - a.bytes);
}

export function register(router, { games }) {
    router.get("/api/games/:id/cache", ({ params }) => {
        const game = games.get(params.id);
        const run = runs.get(game.id);
        return {
            workDir: game.workDir,
            running: Boolean(run && run.status === "running"),
            ...surveyWorkDir(game.workDir),
        };
    });

    router.post("/api/games/:id/cache/clear", async ({ req, params }) => {
        const body = await readJson(req);
        const game = games.get(params.id);
        assertIdle(game.id);
        const result = clearGroups(game.workDir, body.groups);
        fs.mkdirSync(game.workDir, { recursive: true });
        return { ...result, ...surveyWorkDir(game.workDir) };
    });

    router.get("/api/cache/orphans", () => {
        const orphans = findOrphans(games.home, games.list());
        return { home: games.home, orphans, bytes: orphans.reduce((n, o) => n + o.bytes, 0) };
    });

    router.post("/api/cache/orphans/clear", async ({ req }) => {
        await readJson(req);
        assertNothingRunning();
        const orphans = findOrphans(games.home, games.list());
        for (const o of orphans) fs.rmSync(o.dir, { recursive: true, force: true });
        return { removed: orphans.length, freed: orphans.reduce((n, o) => n + o.bytes, 0) };
    });
}
