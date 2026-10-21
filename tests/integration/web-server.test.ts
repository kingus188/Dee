import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createServer, request, type IncomingHttpHeaders, type Server } from "node:http";
import { connect, type AddressInfo, type Socket } from "node:net";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, mkdir, writeFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";

interface WebInstance { origin: string; server: Server; close(): Promise<void> }
interface WebOptions { host?: string; port?: number; apiOrigin?: string; distDir?: string }
const moduleUrl = new URL("../../.build/scripts/web-server.js", import.meta.url).href;
// This intentionally exercises the separately compiled CLI module loading boundary, outside the tests rootDir.
const { startWebServer } = await import(moduleUrl) as { startWebServer(options: WebOptions): Promise<WebInstance> };

async function listen(server: Server) {
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function fixture(t: TestContext, backend?: Server, host = "127.0.0.1") {
  const dir = await mkdtemp(join(tmpdir(), "independent-web-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const dist = join(dir, "dist");
  await mkdir(dist);
  await writeFile(join(dist, "index.html"), "<!doctype html><title>Independent web</title>");
  await writeFile(join(dist, "icon.svg"), "<svg></svg>");
  await writeFile(join(dist, "pixel.png"), Buffer.from([137, 80, 78, 71]));
  for (const name of ["app.js.map", "source.ts", "types.d.ts", "cache.tsbuildinfo", ".private.json"]) {
    await writeFile(join(dist, name), "private-source");
  }
  await writeFile(join(dir, "secret.txt"), "outside-secret");
  await symlink(join(dir, "secret.txt"), join(dist, "escape.txt"));
  await symlink(dir, join(dist, "escape-dir"));
  const api = backend ?? createServer((_req, res) => res.end("unused"));
  const apiSockets = new Set<Socket>();
  api.on("connection", socket => {
    apiSockets.add(socket);
    socket.on("close", () => apiSockets.delete(socket));
  });
  const apiOrigin = await listen(api);
  t.after(async () => {
    for (const socket of apiSockets) socket.destroy();
    if (api.listening) await new Promise<void>((resolve, reject) => api.close(error => error ? reject(error) : resolve()));
  });
  const web = await startWebServer({ port: 0, host, distDir: dist, apiOrigin });
  t.after(() => web.close());
  const address = web.server.address() as AddressInfo;
  const origin = `http://127.0.0.1:${address.port}`;
  return { web, origin, apiOrigin, api };
}

async function http(origin: string, path: string, options: { method?: string; headers?: Record<string, string>; chunks?: Array<string | Buffer> } = {}) {
  return new Promise<{ status: number; headers: IncomingHttpHeaders; body: Buffer }>((resolve, reject) => {
    const req = request(origin, { path, method: options.method ?? "GET", headers: options.headers }, res => {
      const chunks: Buffer[] = [];
      res.on("data", chunk => chunks.push(Buffer.from(chunk)));
      res.on("end", () => resolve({ status: res.statusCode!, headers: res.headers, body: Buffer.concat(chunks) }));
      res.on("error", reject);
    });
    req.on("error", reject);
    for (const chunk of options.chunks ?? []) req.write(chunk);
    req.end();
  });
}

test("independent web serves SPA and correct image MIME without escaping its root", { timeout: 10000 }, async t => {
  const { origin } = await fixture(t);
  for (const path of ["/", "/conversation/123"]) {
    const response = await http(origin, path);
    assert.equal(response.status, 200);
    assert.match(response.body.toString(), /Independent web/);
    assert.match(response.headers["content-type"]!, /^text\/html/);
    assert.equal(response.headers["x-content-type-options"], "nosniff");
  }
  assert.equal((await http(origin, "/icon.svg")).headers["content-type"], "image/svg+xml");
  assert.equal((await http(origin, "/pixel.png")).headers["content-type"], "image/png");
  assert.equal((await http(origin, "/missing.js")).status, 404);
  for (const path of ["/app.js.map", "/source.ts", "/types.d.ts", "/cache.tsbuildinfo", "/.private.json"]) {
    const response = await http(origin, path);
    assert.equal(response.status, 404);
    assert.doesNotMatch(response.body.toString(), /private-source/);
  }
  assert.equal((await http(origin, "/icon.svg", { method: "HEAD" })).body.length, 0);
  for (const path of ["/../secret.txt", "/%2e%2e/secret.txt", "/%2e%2e%5csecret.txt", "/escape.txt", "/escape-dir/secret.txt", "/%00.txt"]) {
    const response = await http(origin, path);
    assert.equal(response.status, 403, path);
    assert.doesNotMatch(response.body.toString(), /outside-secret/);
  }
  assert.equal((await http(origin, "/%E0%A4%A")).status, 400);
  assert.equal((await http(origin, "//evil.test/api/info")).status, 400);
  assert.equal((await http(origin, "http://evil.test/api/info")).status, 400);
});

test("gateway streams auth, request bodies, downloads and preserves security headers", { timeout: 10000 }, async t => {
  let seenOrigin: string | undefined;
  let seenHost: string | undefined;
  let seenAuth: string | undefined;
  let seenCookie: string | undefined;
  let seenForwarded: string | string[] | undefined;
  const backend = createServer((req, res) => {
    seenOrigin = req.headers.origin;
    seenHost = req.headers.host;
    seenAuth = req.headers.authorization;
    seenCookie = req.headers.cookie;
    seenForwarded = req.headers["x-forwarded-host"];
    res.writeHead(200, {
      "content-type": "application/octet-stream", "content-disposition": "attachment; filename=payload.bin",
      "content-security-policy": "default-src 'none'", "x-content-type-options": "nosniff",
      "set-cookie": ["session=one; HttpOnly", "other=two; HttpOnly"],
    });
    req.pipe(res);
  });
  const { origin, apiOrigin } = await fixture(t, backend);
  const chunks = [Buffer.alloc(128 * 1024, 7), Buffer.alloc(128 * 1024, 9)];
  const response = await http(origin, "/api/upload?filename=x", {
    method: "POST", chunks, headers: {
      origin, authorization: "Bearer local-test", cookie: "session=local-test", "x-forwarded-host": "evil.test",
    },
  });
  assert.equal(response.status, 200);
  assert.deepEqual(response.body, Buffer.concat(chunks));
  assert.equal(seenOrigin, apiOrigin);
  assert.equal(seenHost, new URL(apiOrigin).host);
  assert.equal(seenAuth, "Bearer local-test");
  assert.equal(seenCookie, "session=local-test");
  assert.equal(seenForwarded, undefined);
  assert.equal(response.headers["content-security-policy"], "default-src 'none'");
  assert.equal(response.headers["content-disposition"], "attachment; filename=payload.bin");
  assert.equal(response.headers["set-cookie"]?.length, 2);
});

test("request and response streaming deliver bytes before the client finishes uploading", { timeout: 10000 }, async t => {
  const backend = createServer((req, res) => { res.writeHead(200); req.pipe(res); });
  const { origin } = await fixture(t, backend);
  await new Promise<void>((resolve, reject) => {
    const req = request(origin, { method: "POST", path: "/api/stream", headers: { origin } }, res => {
      res.once("data", chunk => {
        assert.equal(chunk.toString(), "first");
        req.end("last");
      });
      res.on("end", resolve);
      res.on("error", reject);
      res.resume();
    });
    req.on("error", reject);
    req.write("first");
  });
});

test("CSRF rejection precedes Origin rewrite; mapped ports and HTTPS termination work", { timeout: 10000 }, async t => {
  let calls = 0;
  let seenOrigin: string | undefined;
  const backend = createServer((req, res) => { calls++; seenOrigin = req.headers.origin; res.end("ok"); });
  const { origin, apiOrigin } = await fixture(t, backend, "0.0.0.0");
  for (const badOrigin of ["http://evil.test", "null", `${origin}/`, `${origin}?x=1`, `${origin}#x`, `http://user@${new URL(origin).host}`, "file://local"]) {
    assert.equal((await http(origin, "/api/change", { method: "POST", headers: { origin: badOrigin } })).status, 403);
  }
  assert.equal((await http(origin, "/api/change", { method: "POST" })).status, 403);
  assert.equal((await http(origin, "/api/info", { headers: { origin: "http://evil.test" } })).status, 403);
  assert.equal((await http(origin, "/api/change", { method: "POST", headers: { origin, host: "other.test:3300" } })).status, 403);
  assert.equal((await http(origin, "/api/info", { headers: { "sec-fetch-site": "cross-site" } })).status, 403);
  assert.equal(calls, 0);
  assert.equal((await http(origin, "/api/change", { method: "POST", headers: { host: "localhost:3300", origin: "http://localhost:3300" } })).status, 200);
  assert.equal((await http(origin, "/api/change", { method: "POST", headers: { host: "app.example:443", origin: "https://app.example", "x-forwarded-proto": "https" } })).status, 200);
  assert.equal(seenOrigin, apiOrigin);
  assert.equal((await http(origin, "/api/info")).status, 200);
});

test("offline API yields a generic 502 while static Web remains available", { timeout: 10000 }, async t => {
  const { origin, api, apiOrigin } = await fixture(t);
  await new Promise<void>((resolve, reject) => api.close(error => error ? reject(error) : resolve()));
  const response = await http(origin, "/api/info");
  assert.equal(response.status, 502);
  assert.equal(response.body.toString(), "API unavailable");
  assert.doesNotMatch(response.body.toString(), new RegExp(new URL(apiOrigin).port));
  assert.equal((await http(origin, "/")).status, 200);
  const { socket } = websocket(origin, origin);
  t.after(() => socket.destroy());
  const handshake = await readHandshake(socket);
  assert.match(handshake.headers, /^HTTP\/1.1 502/);
  socket.destroy();
});

function websocket(origin: string, suppliedOrigin: string | undefined) {
  const url = new URL(origin);
  const socket = connect(Number(url.port), url.hostname);
  const key = randomBytes(16).toString("base64");
  socket.on("connect", () => socket.write([
    "GET /api/socket HTTP/1.1", `Host: ${url.host}`, "Connection: Upgrade", "Upgrade: websocket",
    `Sec-WebSocket-Key: ${key}`, "Sec-WebSocket-Version: 13", "Cookie: session=ws-test",
    ...(suppliedOrigin === undefined ? [] : [`Origin: ${suppliedOrigin}`]), "", "",
  ].join("\r\n")));
  return { socket, key };
}

async function readHandshake(socket: Socket) {
  let bytes = Buffer.alloc(0);
  for await (const chunk of socket.iterator({ destroyOnReturn: false })) {
    bytes = Buffer.concat([bytes, chunk]);
    const end = bytes.indexOf("\r\n\r\n");
    if (end !== -1) return { headers: bytes.subarray(0, end).toString(), rest: bytes.subarray(end + 4) };
  }
  throw new Error("WebSocket closed before handshake");
}

test("real WebSocket handshake and masked message roundtrip; malicious Origins never reach API", { timeout: 10000 }, async t => {
  let upgrades = 0;
  let received = "";
  let apiOrigin = "";
  const backend = createServer();
  backend.on("upgrade", (req, socket) => {
    upgrades++;
    assert.equal(req.headers.origin, apiOrigin);
    assert.equal(req.headers.cookie, "session=ws-test");
    const accept = createHash("sha1").update(req.headers["sec-websocket-key"]! + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    let buffer = Buffer.alloc(0);
    socket.on("data", chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length < 6) return;
      assert.equal(buffer[0], 0x81);
      assert.equal(buffer[1]! & 0x80, 0x80);
      const length = buffer[1]! & 0x7f;
      if (buffer.length < 6 + length) return;
      const payload = Buffer.from(buffer.subarray(6, 6 + length));
      for (let i = 0; i < length; i++) payload[i] = payload[i]! ^ buffer[2 + i % 4]!;
      received = payload.toString();
      socket.write(Buffer.concat([Buffer.from([0x81, length]), payload]));
    });
    socket.on("error", () => {});
  });
  const fixtureValue = await fixture(t, backend);
  const { origin, web } = fixtureValue;
  apiOrigin = fixtureValue.apiOrigin;
  for (const bad of ["http://evil.test", "null", undefined]) {
    const { socket } = websocket(origin, bad);
    const closed = once(socket, "close");
    const handshake = await readHandshake(socket);
    assert.match(handshake.headers, /^HTTP\/1.1 403/);
    socket.destroy();
    await closed;
  }
  assert.equal(upgrades, 0);
  const { socket, key } = websocket(origin, origin);
  t.after(() => socket.destroy());
  const handshake = await readHandshake(socket);
  assert.match(handshake.headers, /^HTTP\/1.1 101/);
  const accept = createHash("sha1").update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
  assert.ok(handshake.headers.toLowerCase().includes(`sec-websocket-accept: ${accept}`.toLowerCase()));
  const mask = Buffer.from([1, 2, 3, 4]);
  const payload = Buffer.from("hello");
  const encoded = Buffer.from(payload);
  for (let i = 0; i < encoded.length; i++) encoded[i] = encoded[i]! ^ mask[i % 4]!;
  const echoed = once(socket, "data");
  socket.write(Buffer.concat([Buffer.from([0x81, 0x80 | payload.length]), mask, encoded]));
  const [frame] = await echoed as [Buffer];
  assert.deepEqual(frame, Buffer.concat([Buffer.from([0x81, payload.length]), payload]));
  assert.equal(received, "hello");
  assert.equal(upgrades, 1);
  const closed = once(socket, "close");
  await web.close();
  await closed;
});
