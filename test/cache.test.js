import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CACHE_GROUPS, clearGroups, findOrphans, measure, surveyWorkDir, register } from "../server/cache.js";
import { GameStore } from "../server/games.js";
import { createServer, listen, Router } from "../server/http.js";

function tmpHome() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ren2leaf-cache-"));
    return dir;
}

/** A work directory with one of everything the groups name. */
function fillWork(workDir) {
    fs.mkdirSync(path.join(workDir, "manual", "0001"), { recursive: true });
    fs.writeFileSync(path.join(workDir, "manual", "0001", "full.png"), Buffer.alloc(2048));
    fs.mkdirSync(path.join(workDir, "manual-run", "game"), { recursive: true });
    fs.writeFileSync(path.join(workDir, "manual-run", "game", "script.rpy"), "x".repeat(1024));
    fs.writeFileSync(path.join(workDir, "manual-job.json"), "{}");
    fs.writeFileSync(path.join(workDir, "inventory.json"), "{}");
    fs.mkdirSync(path.join(workDir, "decisions"), { recursive: true });
    fs.writeFileSync(path.join(workDir, "decisions", "speakers.json"), "{\"speakers\":{}}");
    fs.mkdirSync(path.join(workDir, "export"), { recursive: true });
    fs.writeFileSync(path.join(workDir, "export", "README.md"), "# hi");
}

test("measure adds up a directory and reports a missing path as absent", () => {
    const dir = tmpHome();
    fs.writeFileSync(path.join(dir, "a"), Buffer.alloc(100));
    fs.mkdirSync(path.join(dir, "sub"));
    fs.writeFileSync(path.join(dir, "sub", "b"), Buffer.alloc(50));
    assert.deepEqual(measure(dir), { bytes: 150, files: 2, exists: true });
    assert.equal(measure(path.join(dir, "nope")).exists, false);
});

test("the survey reports each group and keeps decisions apart", () => {
    const work = path.join(tmpHome(), "work", "0123456789");
    fs.mkdirSync(work, { recursive: true });
    fillWork(work);
    const survey = surveyWorkDir(work);
    const byId = Object.fromEntries(survey.groups.map((g) => [g.id, g]));
    assert.ok(byId.runs.bytes >= 1024);
    assert.ok(byId.shots.bytes >= 2048);
    assert.ok(byId.scan.bytes > 0);
    assert.ok(byId.export.bytes > 0);
    assert.equal(byId.decisions.precious, true);
    assert.equal(survey.other, 0);
    assert.equal(survey.bytes, survey.groups.reduce((n, g) => n + g.bytes, 0));
    // Nothing is precious except the migrator's own answers.
    assert.deepEqual(CACHE_GROUPS.filter((g) => g.precious).map((g) => g.id), ["decisions"]);
});

test("clearing a group removes only its entries", () => {
    const work = path.join(tmpHome(), "work", "0123456789");
    fs.mkdirSync(work, { recursive: true });
    fillWork(work);
    const { removed, freed } = clearGroups(work, ["runs", "shots"]);
    assert.ok(freed >= 3072);
    assert.deepEqual(removed.map((r) => r.id), ["runs", "shots"]);
    assert.equal(fs.existsSync(path.join(work, "manual-run")), false);
    assert.equal(fs.existsSync(path.join(work, "manual")), false);
    assert.equal(fs.existsSync(path.join(work, "manual-job.json")), false);
    assert.equal(fs.existsSync(path.join(work, "inventory.json")), true);
    assert.equal(fs.existsSync(path.join(work, "decisions", "speakers.json")), true);
    assert.equal(fs.existsSync(path.join(work, "export", "README.md")), true);
});

test("clearing rejects an empty or unknown selection", () => {
    const work = path.join(tmpHome(), "work", "0123456789");
    fs.mkdirSync(work, { recursive: true });
    assert.throws(() => clearGroups(work, []), { code: "nothing_selected" });
    assert.throws(() => clearGroups(work, ["../.."]), { code: "bad_group" });
});

test("findOrphans lists work directories no listed game owns", () => {
    const home = tmpHome();
    const store = new GameStore(home);
    const mine = path.join(home, "work", "aaaaaaaaaa");
    const stale = path.join(home, "work", "bbbbbbbbbb");
    fs.mkdirSync(mine, { recursive: true });
    fs.mkdirSync(stale, { recursive: true });
    fs.writeFileSync(path.join(stale, "inventory.json"), Buffer.alloc(64));
    store.write([{ id: "aaaaaaaaaa", name: "g", path: "/nowhere" }]);
    const orphans = findOrphans(home, store.list());
    assert.deepEqual(orphans.map((o) => o.id), ["bbbbbbbbbb"]);
    assert.equal(orphans[0].bytes, 64);
});

test("the routes survey and clear a game's work directory", async () => {
    const home = tmpHome();
    const root = path.join(home, "sample");
    fs.mkdirSync(path.join(root, "game"), { recursive: true });
    const store = new GameStore(home);
    const { game } = store.add(root);
    fillWork(game.workDir);

    const router = new Router();
    register(router, { games: store });
    const server = createServer({ webRoot: home, router });
    const port = await listen(server, 0);
    const base = `http://127.0.0.1:${port}`;
    try {
        const before = await fetch(`${base}/api/games/${game.id}/cache`).then((r) => r.json());
        assert.equal(before.running, false);
        assert.ok(before.bytes > 0);

        const res = await fetch(`${base}/api/games/${game.id}/cache/clear`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ groups: ["runs", "scan"] }),
        });
        const after = await res.json();
        assert.equal(res.status, 200);
        assert.ok(after.freed > 0);
        // The work directory itself survives a sweep, and so do the answers in it.
        assert.equal(fs.existsSync(game.workDir), true);
        assert.equal(fs.existsSync(path.join(game.workDir, "decisions", "speakers.json")), true);
        assert.equal(after.groups.find((g) => g.id === "scan").bytes, 0);

        const bad = await fetch(`${base}/api/games/${game.id}/cache/clear`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ groups: ["nope"] }),
        });
        assert.equal(bad.status, 400);
        assert.equal((await bad.json()).error.code, "bad_group");
    } finally {
        server.close();
    }
});
