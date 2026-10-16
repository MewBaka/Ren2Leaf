// Local HTTP server: a small router, static files from web/, JSON and SSE helpers.
// Listens on 127.0.0.1 only. Requests whose Host is not this machine are refused (DNS rebinding),
// and writes must carry a JSON body, which a cross-site form cannot send without a preflight.

import http from "node:http";
import fs from "node:fs";
import path from "node:path";

const MIME = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".svg": "image/svg+xml",
    ".ico": "image/x-icon",
    ".txt": "text/plain; charset=utf-8",
};

export class HttpError extends Error {
    constructor(status, message, code) {
        super(message);
        this.status = status;
        this.code = code;
    }
}

export function sendJson(res, status, body) {
    const data = JSON.stringify(body);
    res.writeHead(status, {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Length": Buffer.byteLength(data),
        "Cache-Control": "no-store",
    });
    res.end(data);
}

export async function readJson(req, limit = 1 << 20) {
    const type = req.headers["content-type"] || "";
    if (!type.startsWith("application/json")) {
        throw new HttpError(415, "需要 JSON 请求体", "bad_content_type");
    }
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
        size += chunk.length;
        if (size > limit) throw new HttpError(413, "请求体过大", "too_large");
        chunks.push(chunk);
    }
    const text = Buffer.concat(chunks).toString("utf8");
    if (!text) return {};
    try {
        return JSON.parse(text);
    } catch {
        throw new HttpError(400, "JSON 无法解析", "bad_json");
    }
}

/**
 * Turns a response into an event stream. `send(event, data)` writes one event; a comment line
 * every 15s keeps proxies and the browser from timing out. `onClose` fires when the client leaves.
 */
export function openSse(req, res) {
    res.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-store",
        Connection: "keep-alive",
    });
    res.write(": open\n\n");
    let closed = false;
    const listeners = [];
    const ping = setInterval(() => res.write(": ping\n\n"), 15000);
    const finish = () => {
        if (closed) return;
        closed = true;
        clearInterval(ping);
        for (const fn of listeners) fn();
    };
    req.on("close", finish);
    return {
        send(event, data) {
            if (closed) return;
            if (event) res.write(`event: ${event}\n`);
            const lines = JSON.stringify(data ?? null).split("\n");
            for (const line of lines) res.write(`data: ${line}\n`);
            res.write("\n");
        },
        close() {
            if (closed) return;
            res.end();
            finish();
        },
        onClose(fn) {
            listeners.push(fn);
        },
        get closed() {
            return closed;
        },
    };
}

export class Router {
    constructor() {
        this.routes = [];
    }

    /** `pattern` is a path like `/api/games/:id`; params arrive in `ctx.params`. */
    add(method, pattern, handler) {
        const names = [];
        const source = pattern.replace(/\/:([A-Za-z_]\w*)/g, (_, name) => {
            names.push(name);
            return "/([^/]+)";
        });
        this.routes.push({ method, regex: new RegExp(`^${source}$`), names, handler });
        return this;
    }

    get(pattern, handler) { return this.add("GET", pattern, handler); }
    post(pattern, handler) { return this.add("POST", pattern, handler); }
    put(pattern, handler) { return this.add("PUT", pattern, handler); }
    delete(pattern, handler) { return this.add("DELETE", pattern, handler); }

    match(method, pathname) {
        let pathMatched = false;
        for (const route of this.routes) {
            const m = route.regex.exec(pathname);
            if (!m) continue;
            pathMatched = true;
            if (route.method !== method && !(method === "HEAD" && route.method === "GET")) continue;
            const params = {};
            route.names.forEach((name, i) => { params[name] = decodeURIComponent(m[i + 1]); });
            return { route, params };
        }
        return pathMatched ? { methodNotAllowed: true } : null;
    }
}

function serveStatic(webRoot, pathname, req, res) {
    let rel;
    try {
        rel = decodeURIComponent(pathname);
    } catch {
        return false;
    }
    if (rel.endsWith("/")) rel += "index.html";
    const file = path.resolve(webRoot, "." + rel);
    if (file !== webRoot && !file.startsWith(webRoot + path.sep)) return false;
    let stat;
    try {
        stat = fs.statSync(file);
    } catch {
        return false;
    }
    if (!stat.isFile()) return false;
    res.writeHead(200, {
        "Content-Type": MIME[path.extname(file).toLowerCase()] || "application/octet-stream",
        "Content-Length": stat.size,
        "Cache-Control": "no-cache",
    });
    if (req.method === "HEAD") {
        res.end();
    } else {
        fs.createReadStream(file).pipe(res);
    }
    return true;
}

/**
 * Serves a file from anywhere on disk, for routes that hand out work-directory output
 * (screenshots, JSON). The caller is responsible for deciding the path is allowed.
 */
export function sendFile(req, res, file) {
    let stat;
    try {
        stat = fs.statSync(file);
    } catch {
        throw new HttpError(404, "文件不存在", "not_found");
    }
    if (!stat.isFile()) throw new HttpError(404, "文件不存在", "not_found");
    res.writeHead(200, {
        "Content-Type": MIME[path.extname(file).toLowerCase()] || "application/octet-stream",
        "Content-Length": stat.size,
        "Cache-Control": "no-cache",
    });
    if (req.method === "HEAD") res.end();
    else fs.createReadStream(file).pipe(res);
}

function hostAllowed(host, port) {
    if (!host) return false;
    return host === `127.0.0.1:${port}` || host === `localhost:${port}` || host === `[::1]:${port}`;
}

export function createServer({ webRoot, router }) {
    const root = path.resolve(webRoot);
    const server = http.createServer(async (req, res) => {
        const port = server.address()?.port;
        if (!hostAllowed(req.headers.host, port)) {
            res.writeHead(403).end();
            return;
        }
        const url = new URL(req.url, `http://${req.headers.host}`);
        const pathname = url.pathname;
        try {
            const found = router.match(req.method, pathname);
            if (found?.route) {
                const result = await found.route.handler({ req, res, url, params: found.params });
                if (!res.headersSent && !res.writableEnded) {
                    if (result === undefined) res.writeHead(204).end();
                    else sendJson(res, 200, result);
                }
                return;
            }
            if (found?.methodNotAllowed) throw new HttpError(405, "方法不允许", "method_not_allowed");
            if (pathname.startsWith("/api/")) throw new HttpError(404, "接口不存在", "not_found");
            if ((req.method === "GET" || req.method === "HEAD") && serveStatic(root, pathname, req, res)) return;
            res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }).end("Not found");
        } catch (err) {
            if (res.headersSent) {
                res.destroy(err);
                return;
            }
            const status = err instanceof HttpError ? err.status : 500;
            if (status === 500) console.error(err);
            sendJson(res, status, {
                error: { message: err.message || "内部错误", code: err.code || "internal" },
            });
        }
    });
    return server;
}

export function listen(server, port = 0) {
    return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, "127.0.0.1", () => {
            server.off("error", reject);
            resolve(server.address().port);
        });
    });
}
