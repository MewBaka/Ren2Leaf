#!/usr/bin/env node
// Ren2Leaf: starts the local WebUI on 127.0.0.1 and opens it in the browser.
//   node ren2leaf.js [--port 4710] [--no-open]

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execFile } from "node:child_process";
import { createServer, listen, Router } from "./server/http.js";
import { GameStore, registerGameRoutes } from "./server/games.js";

const here = path.dirname(fileURLToPath(import.meta.url));

// Step modules add their routes here. Each exports `register(router, ctx)`; a module that is not
// written yet is skipped, so the shell runs on its own.
const STEP_MODULES = ["server/diagnose/index.js", "server/capture.js", "server/decisions.js", "server/portraits.js", "server/export.js"];

function parseArgs(argv) {
    const args = { port: 4710, open: true };
    for (let i = 0; i < argv.length; i++) {
        if (argv[i] === "--port") args.port = Number(argv[++i]);
        else if (argv[i] === "--no-open") args.open = false;
    }
    return args;
}

function openBrowser(url) {
    const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open";
    execFile(cmd, [url], () => {});
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const router = new Router();
    const games = new GameStore();
    const ctx = { games, root: here };

    registerGameRoutes(router, games);
    router.get("/api/health", () => ({ ok: true }));

    for (const rel of STEP_MODULES) {
        const file = path.join(here, rel);
        if (!fs.existsSync(file)) continue;
        const mod = await import(pathToFileURL(file).href);
        if (typeof mod.register === "function") await mod.register(router, ctx);
    }

    const server = createServer({ webRoot: path.join(here, "web"), router });
    let port;
    try {
        port = await listen(server, args.port);
    } catch (err) {
        if (err.code !== "EADDRINUSE") throw err;
        port = await listen(server, 0);
    }
    const url = `http://127.0.0.1:${port}/`;
    console.log(`Ren2Leaf ${url}`);
    if (args.open) openBrowser(url);
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
