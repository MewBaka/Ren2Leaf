import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { GameStore, cleanInputPath, resolveGameRoot, guessName, gameId } from "../server/games.js";
import { createServer, listen, Router } from "../server/http.js";
import { registerGameRoutes } from "../server/games.js";

let tmp;

function makeGame(name, { configName, withGame = true } = {}) {
    const root = path.join(tmp, "games", name);
    fs.mkdirSync(root, { recursive: true });
    if (withGame) {
        fs.mkdirSync(path.join(root, "game"), { recursive: true });
        if (configName) {
            fs.writeFileSync(
                path.join(root, "game", "options.rpy"),
                `## options\ndefine config.name = _("${configName}")\n`,
            );
        }
    }
    return fs.realpathSync(root);
}

before(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ren2leaf-test-"));
});

after(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
});

test("cleanInputPath strips quotes, escapes, ~ and trailing slashes", () => {
    assert.equal(cleanInputPath("  '/a/b c/'  "), "/a/b c");
    assert.equal(cleanInputPath("\"/a/b\""), "/a/b");
    assert.equal(cleanInputPath("/a/b\\ c"), "/a/b c");
    assert.equal(cleanInputPath("~/x"), path.join(os.homedir(), "x"));
    assert.equal(cleanInputPath("file:///a/b%20c/"), "/a/b c");
    assert.equal(cleanInputPath("/"), "/");
});

test("resolveGameRoot accepts the root, its game/ folder and a .app bundle", () => {
    const root = makeGame("Plain");
    assert.equal(resolveGameRoot(root), root);
    assert.equal(resolveGameRoot(path.join(root, "game")), root);

    const app = path.join(tmp, "games", "Bundle.app");
    fs.mkdirSync(path.join(app, "Contents", "Resources", "autorun", "game"), { recursive: true });
    assert.equal(resolveGameRoot(app), fs.realpathSync(path.join(app, "Contents", "Resources", "autorun")));
});

test("resolveGameRoot rejects bad input with a code", () => {
    const noGame = makeGame("NoGame", { withGame: false });
    assert.throws(() => resolveGameRoot(""), { code: "empty_path" });
    assert.throws(() => resolveGameRoot("relative/path"), { code: "relative_path" });
    assert.throws(() => resolveGameRoot(path.join(tmp, "missing")), { code: "not_found" });
    assert.throws(() => resolveGameRoot(noGame), { code: "no_game_dir" });
});

test("guessName prefers config.name, else the folder name without build suffixes", () => {
    assert.equal(guessName(makeGame("Named", { configName: "The Title" })), "The Title");
    assert.equal(guessName(makeGame("Some-Game-1.0-pc")), "Some-Game-1.0");
    assert.equal(guessName(makeGame("Other-RenPy")), "Other");
});

test("GameStore adds, dedupes, lists, updates meta and removes", () => {
    const home = path.join(tmp, "home-store");
    const store = new GameStore(home);
    assert.deepEqual(store.list(), []);

    const root = makeGame("StoreGame", { configName: "Store Game" });
    const first = store.add(root + "/");
    assert.equal(first.added, true);
    assert.equal(first.game.id, gameId(root));
    assert.equal(first.game.name, "Store Game");
    assert.equal(first.game.path, root);
    assert.equal(first.game.present, true);
    assert.equal(first.game.workDir, path.join(home, "work", first.game.id));
    assert.ok(fs.statSync(first.game.workDir).isDirectory());

    const again = store.add(path.join(root, "game"));
    assert.equal(again.added, false);
    assert.equal(store.list().length, 1);

    const updated = store.updateMeta(first.game.id, { sdk: "8.5.2", resolution: "1280×720" });
    assert.equal(updated.meta.sdk, "8.5.2");
    assert.equal(store.get(first.game.id).meta.resolution, "1280×720");

    const saved = JSON.parse(fs.readFileSync(path.join(home, "games.json"), "utf8"));
    assert.equal(saved.version, 1);
    assert.equal(saved.games.length, 1);
    assert.equal(saved.games[0].workDir, undefined, "derived fields are not persisted");

    store.remove(first.game.id);
    assert.deepEqual(store.list(), []);
    assert.ok(fs.existsSync(first.game.workDir), "removing keeps the work directory");
    assert.throws(() => store.remove(first.game.id), { code: "game_not_found" });
    assert.throws(() => store.get(first.game.id), { code: "game_not_found" });
});

test("GameStore marks a game whose folder disappeared", () => {
    const store = new GameStore(path.join(tmp, "home-missing"));
    const root = makeGame("Vanishing");
    const { game } = store.add(root);
    fs.rmSync(root, { recursive: true });
    assert.equal(store.get(game.id).present, false);
});

test("workDir rejects ids that are not ours", () => {
    const store = new GameStore(path.join(tmp, "home-ids"));
    assert.throws(() => store.workDir("../../etc"), { code: "bad_id" });
});

test("HTTP routes add, list and remove games", async () => {
    const store = new GameStore(path.join(tmp, "home-http"));
    const router = new Router();
    registerGameRoutes(router, store);
    const server = createServer({ webRoot: path.join(tmp, "web"), router });
    const port = await listen(server, 0);
    const base = `http://127.0.0.1:${port}`;
    const json = { "Content-Type": "application/json" };
    try {
        const root = makeGame("HttpGame", { configName: "Http Game" });

        let res = await fetch(`${base}/api/games`, { method: "POST", headers: json, body: JSON.stringify({ path: root }) });
        assert.equal(res.status, 200);
        const { game } = await res.json();
        assert.equal(game.name, "Http Game");

        res = await fetch(`${base}/api/games`, { method: "POST", headers: json, body: JSON.stringify({ path: tmp }) });
        assert.equal(res.status, 400);
        assert.equal((await res.json()).error.code, "no_game_dir");

        res = await fetch(`${base}/api/games`, { method: "POST", body: "path=x" });
        assert.equal(res.status, 415, "form posts are refused");

        res = await fetch(`${base}/api/games`);
        assert.equal((await res.json()).games.length, 1);

        res = await fetch(`${base}/api/games/${game.id}`, { method: "DELETE" });
        assert.equal(res.status, 204);
        res = await fetch(`${base}/api/games/${game.id}`);
        assert.equal(res.status, 404);
    } finally {
        server.close();
    }
});

test("HTTP server refuses foreign Host headers", async () => {
    const router = new Router();
    router.get("/api/ping", () => ({ ok: true }));
    const server = createServer({ webRoot: tmp, router });
    const port = await listen(server, 0);
    try {
        const http = await import("node:http");
        const status = await new Promise((resolve, reject) => {
            http.get({ host: "127.0.0.1", port, path: "/api/ping", headers: { Host: "evil.example" } }, (res) => {
                res.resume();
                resolve(res.statusCode);
            }).on("error", reject);
        });
        assert.equal(status, 403);
        const ok = await fetch(`http://127.0.0.1:${port}/api/ping`);
        assert.equal(ok.status, 200);
    } finally {
        server.close();
    }
});

describe("game list recovery", () => {
    let home;
    let store;

    before(() => {
        home = fs.mkdtempSync(path.join(os.tmpdir(), "ren2leaf-home-"));
        store = new GameStore(home);
    });
    after(() => fs.rmSync(home, { recursive: true, force: true }));

    test("a list that empties itself on its own comes back", () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ren2leaf-game-"));
        fs.mkdirSync(path.join(dir, "game"), { recursive: true });
        const { game } = store.add(dir);
        assert.equal(store.list().length, 1);

        // Whatever wiped it, it was not a removal: the backup still has the game.
        fs.writeFileSync(path.join(home, "games.json"), JSON.stringify({ version: 1, games: [] }));
        const back = store.list();
        assert.equal(back.length, 1);
        assert.equal(back[0].id, game.id);
        assert.deepEqual(JSON.parse(fs.readFileSync(path.join(home, "games.json"), "utf8")).games.map((g) => g.id), [game.id]);

        // A removal is meant to stick.
        store.remove(game.id);
        assert.deepEqual(store.list(), []);
        assert.equal(fs.existsSync(path.join(home, "games.backup.json")), false);
        fs.rmSync(dir, { recursive: true, force: true });
    });

    test("a corrupt list falls back to the backup instead of throwing", () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ren2leaf-game-"));
        fs.mkdirSync(path.join(dir, "game"), { recursive: true });
        store.add(dir);
        fs.writeFileSync(path.join(home, "games.json"), "{ not json");
        assert.equal(store.list().length, 1);
        fs.rmSync(dir, { recursive: true, force: true });
    });
});
