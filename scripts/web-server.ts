import { createServer, request as httpRequest, type ClientRequest, type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from "node:http";
import { request as httpsRequest } from "node:https";
import { createReadStream } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import { extname, isAbsolute, relative, resolve } from "node:path";
import type { Socket } from "node:net";
import { fileURLToPath, pathToFileURL } from "node:url";

export interface WebServerOptions {
  host?: string;
  port?: number;
  apiOrigin?: string;
  distDir?: string;
}

const mimeTypes: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp",
  ".ico": "image/x-icon", ".woff": "font/woff", ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};
const hopHeaders: Record<string, true> = { connection: true, "keep-alive": true, "proxy-authenticate": true, "proxy-authorization": true, te: true, trailer: true, "transfer-encoding": true, upgrade: true };
function cleanHeaders(headers: IncomingHttpHeaders): IncomingHttpHeaders {
  const blocked = new Set([...Object.keys(hopHeaders), ...(headers.connection ?? "").toLowerCase().split(",").map(value => value.trim())]);
  return Object.fromEntries(Object.entries(headers).filter(([key]) => !blocked.has(key)));
}

function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith("../") && !rel.startsWith("..\\"));
}

function reply(res: ServerResponse, status: number, message: string): void {
  if (res.headersSent) { res.destroy(); return; }
  res.writeHead(status, { "content-type": "text/plain; charset=utf-8", "x-content-type-options": "nosniff" });
  res.end(message);
}

function rejectSocket(socket: Socket, status: number, message: string): void {
  if (socket.destroyed) return;
  socket.end(`HTTP/1.1 ${status} ${message}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

/** A fixed-upstream HTTP/WS gateway. Never accepts an upstream URL from a client. */
export async function startWebServer(options: WebServerOptions = {}) {
  const host = options.host ?? process.env.WEB_HOST ?? "127.0.0.1";
  const port = options.port ?? Number(process.env.WEB_PORT ?? 8080);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("Invalid WEB_PORT");
  let upstream: URL;
  try { upstream = new URL(options.apiOrigin ?? process.env.API_ORIGIN ?? "http://127.0.0.1:3000"); }
  catch { throw new Error("Invalid API_ORIGIN"); }
  if (!["http:", "https:"].includes(upstream.protocol) || upstream.username || upstream.password || upstream.pathname !== "/" || upstream.search || upstream.hash) {
    throw new Error("API_ORIGIN must be an HTTP(S) origin without credentials or a path");
  }
  const root = await realpath(options.distDir ?? fileURLToPath(new URL("../../apps/web/dist/", import.meta.url)));
  const sockets = new Set<Socket>();
  const upstreamRequests = new Set<ClientRequest>();
  let origin = "";
  let closing: Promise<void> | undefined;
  const transport = upstream.protocol === "https:" ? httpsRequest : httpRequest;
  function validClient(req: IncomingMessage, websocket = false): boolean {
    const hostHeader = req.headers.host;
    if (!hostHeader || /[\s/@\\?#]/.test(hostHeader)) return false;
    let clientHost: string;
    try { clientHost = new URL(`http://${hostHeader}`).host; }
    catch { return false; }
    if (!clientHost || req.headers["sec-fetch-site"] === "cross-site") return false;
    const supplied = req.headers.origin;
    if (supplied !== undefined) {
      if (typeof supplied !== "string") return false;
      try {
        const parsed = new URL(supplied);
        if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password ||
            parsed.origin !== supplied || parsed.host !== new URL(`${parsed.protocol}//${hostHeader}`).host) return false;
      } catch { return false; }
    } else if (websocket || !["GET", "HEAD", "OPTIONS"].includes(req.method ?? "")) return false;
    return true;
  }

  function proxyHeaders(req: IncomingMessage): IncomingHttpHeaders {
    const headers = cleanHeaders(req.headers);
    for (const key of Object.keys(headers)) {
      if (key === "forwarded" || key.startsWith("x-forwarded-") || key === "x-real-ip") delete headers[key];
    }
    headers.host = upstream.host;
    // Only rewrite a browser Origin after validating it against this Web Host.
    if (req.headers.origin !== undefined) headers.origin = upstream.origin;
    return headers;
  }

  function track(request: ClientRequest) {
    upstreamRequests.add(request);
    request.once("close", () => upstreamRequests.delete(request));
    request.on("socket", socket => {
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
    });
    return request;
  }

  function proxy(req: IncomingMessage, res: ServerResponse) {
    const request = track(transport(upstream, { method: req.method, path: req.url, headers: proxyHeaders(req), agent: false }, response => {
      res.writeHead(response.statusCode ?? 502, cleanHeaders(response.headers));
      response.on("error", () => res.destroy());
      response.pipe(res);
    }));
    request.on("error", () => reply(res, 502, "API unavailable"));
    req.on("aborted", () => request.destroy());
    res.on("close", () => request.destroy());
    req.pipe(request);
  }

  async function serveStatic(req: IncomingMessage, res: ServerResponse) {
    if (req.method !== "GET" && req.method !== "HEAD") { reply(res, 405, "Method not allowed"); return; }
    let pathname: string;
    try { pathname = decodeURIComponent((req.url ?? "/").split("?")[0]!); }
    catch { reply(res, 400, "Bad request"); return; }
    if (pathname.includes("\0") || pathname.includes("\\") || pathname.split("/").includes("..")) { reply(res, 403, "Forbidden"); return; }
    const extension = extname(pathname).toLowerCase();
    if (pathname.split("/").some(segment => segment.startsWith(".")) || (extension && !Object.hasOwn(mimeTypes, extension))) {
      reply(res, 404, "Not found"); return;
    }
    const candidate = resolve(root, `.${pathname}`);
    if (!inside(root, candidate)) { reply(res, 403, "Forbidden"); return; }
    try {
      let target: string;
      try { target = await realpath(candidate); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT" || extname(pathname)) throw error;
        target = await realpath(resolve(root, "index.html"));
      }
      if (!inside(root, target)) { reply(res, 403, "Forbidden"); return; }
      let info = await stat(target);
      if (info.isDirectory()) {
        target = await realpath(resolve(target, "index.html"));
        if (!inside(root, target)) { reply(res, 403, "Forbidden"); return; }
        info = await stat(target);
      }
      if (!info.isFile()) { reply(res, 404, "Not found"); return; }
      if (!Object.hasOwn(mimeTypes, extname(target).toLowerCase())) { reply(res, 404, "Not found"); return; }
      const stream = createReadStream(target);
      stream.on("error", () => reply(res, 404, "Not found"));
      res.writeHead(200, {
        "content-type": mimeTypes[extname(target).toLowerCase()] ?? "application/octet-stream",
        "content-length": info.size, "x-content-type-options": "nosniff",
        "referrer-policy": "same-origin", "x-frame-options": "SAMEORIGIN",
      });
      if (req.method === "HEAD") { stream.destroy(); res.end(); }
      else { res.on("close", () => stream.destroy()); stream.pipe(res); }
    } catch { reply(res, 404, "Not found"); }
  }

  const server = createServer((req, res) => {
    if (!req.url?.startsWith("/") || req.url.startsWith("//")) { reply(res, 400, "Bad request"); return; }
    if (!validClient(req)) { reply(res, 403, "Forbidden"); return; }
    if (/^\/api(?:\/|\?|$)/.test(req.url)) proxy(req, res);
    else void serveStatic(req, res);
  });
  server.on("connection", socket => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  server.on("upgrade", (req, socket, head) => {
    const client = socket as Socket;
    if (!validClient(req, true)) { rejectSocket(client, 403, "Forbidden"); return; }
    if (!req.url || !/^\/api(?:\/|\?|$)/.test(req.url) || req.headers.upgrade?.toLowerCase() !== "websocket") {
      rejectSocket(client, 400, "Bad Request"); return;
    }
    const headers = proxyHeaders(req);
    headers.connection = "Upgrade";
    headers.upgrade = "websocket";
    const request = track(transport(upstream, { method: "GET", path: req.url, headers, agent: false }));
    client.on("error", () => request.destroy());
    client.on("close", () => request.destroy());
    request.on("error", () => rejectSocket(client, 502, "Bad Gateway"));
    request.on("upgrade", (response, remote, remoteHead) => {
      if (client.destroyed) { remote.destroy(); return; }
      const responseHeaders = cleanHeaders(response.headers);
      responseHeaders.connection = "Upgrade";
      responseHeaders.upgrade = "websocket";
      const lines = Object.entries(responseHeaders).flatMap(([key, value]) => value === undefined ? [] :
        (Array.isArray(value) ? value : [String(value)]).map(item => `${key}: ${item}\r\n`));
      client.write(`HTTP/1.1 101 Switching Protocols\r\n${lines.join("")}\r\n`);
      if (remoteHead.length) client.write(remoteHead);
      if (head.length) remote.write(head);
      remote.on("error", () => client.destroy());
      client.on("error", () => remote.destroy());
      remote.on("close", () => client.destroy());
      client.on("close", () => remote.destroy());
      remote.pipe(client);
      client.pipe(remote);
    });
    request.on("response", response => {
      const headers = cleanHeaders(response.headers);
      const lines = Object.entries(headers).flatMap(([key, value]) => value === undefined ? [] :
        (Array.isArray(value) ? value : [String(value)]).map(item => `${key}: ${item}\r\n`));
      client.write(`HTTP/1.1 ${response.statusCode ?? 502} ${response.statusMessage ?? ""}\r\n${lines.join("")}Connection: close\r\n\r\n`);
      response.on("error", () => client.destroy());
      response.pipe(client);
    });
    request.end();
  });
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => { server.off("error", reject); resolveListen(); });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Web server address unavailable");
  origin = `http://${host.includes(":") ? `[${host}]` : host}:${address.port}`;
  return {
    server, origin,
    close(): Promise<void> {
      closing ??= new Promise<void>((resolveClose, reject) => {
        server.close(error => error ? reject(error) : resolveClose());
        for (const request of upstreamRequests) request.destroy();
        for (const socket of sockets) socket.destroy();
      });
      return closing;
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  startWebServer().then(web => {
    console.log(`Web listening on ${web.origin}`);
    const stop = () => { void web.close().catch(() => { process.exitCode = 1; }); };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  }).catch(() => { console.error("Unable to start Web server"); process.exitCode = 1; });
}
