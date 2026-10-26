/// <reference lib="es2024.promise" />
import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { startServer } from "../dist/lifecycle.js";
import { readConfig } from "../dist/config.js";

const password = "browser-session-test-password";
const authorization = "Basic " + Buffer.from(`demo:${password}`).toString("base64");

async function fixture(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), "pi-browser-session-"));
  const server = await startServer(readConfig({ NODE_ENV: "test", LLM_API: "faux", PI_OFFLINE: "1", DATA_DIR: dir, PORT: "0", DEMO_PASSWORD: password, NOTIFY_MODE: "off" }), "127.0.0.1");
  t.after(async () => { await server.close(); await rm(dir, { recursive: true, force: true }); });
  return server;
}

async function session(origin: string) {
  const response = await fetch(origin + "/api/info", { headers: { authorization } });
  assert.equal(response.status, 200);
  const header = response.headers.getSetCookie()[0];
  assert.equal(typeof header, "string", "a successful Basic login must establish a browser session");
  return { response, header: header!, cookie: header!.split(";")[0]! };
}

async function rejectedSocket(origin: string, cookie: string, browserOrigin = origin) {
  const { promise, resolve, reject } = Promise.withResolvers<number>();
  const socket = new WebSocket(origin.replace(/^http/, "ws") + "/api/socket", { headers: { cookie, origin: browserOrigin }, handshakeTimeout: 3000 });
  socket.on("error", reject);
  socket.on("open", () => { reject(new Error("unauthorized WebSocket was accepted")); socket.terminate(); });
  socket.on("unexpected-response", (request, response) => {
    resolve(response.statusCode!); response.destroy(); request.destroy(); socket.terminate();
  });
  return promise;
}

test("verified Basic login issues a protected session without exposing the password", { timeout: 10000 }, async t => {
  const server = await fixture(t);
  const anonymous = await fetch(server.origin + "/api/info");
  assert.equal(anonymous.status, 401);
  assert.equal(anonymous.headers.getSetCookie().length, 0);
  const wrong = await fetch(server.origin + "/api/info", { headers: { authorization: "Basic " + Buffer.from("demo:wrong-password").toString("base64") } });
  assert.equal(wrong.status, 401);
  assert.equal(wrong.headers.getSetCookie().length, 0);
  const { response, header, cookie } = await session(server.origin);
  assert.match(header, /^__Host-pi-durable-session=/);
  for (const attribute of [/;\s*Secure(?:;|$)/i, /;\s*HttpOnly(?:;|$)/i, /;\s*SameSite=Strict(?:;|$)/i, /;\s*Path=\/(?:;|$)/i]) assert.match(header, attribute);
  assert.doesNotMatch(header, /;\s*Domain=/i);
  assert.equal(header.includes(password), false);
  assert.match(response.headers.get("cache-control") ?? "", /no-store/);
  assert.equal((await fetch(server.origin + "/api/info", { headers: { cookie } })).status, 200);
});

test("browser session authenticates WebSocket without Authorization and retains Origin rejection", { timeout: 10000 }, async t => {
  const server = await fixture(t);
  const { cookie } = await session(server.origin);
  assert.equal(await rejectedSocket(server.origin, cookie, "https://unrelated.invalid"), 403);
  const socket = new WebSocket(server.origin.replace(/^http/, "ws") + "/api/socket", { headers: { cookie, origin: server.origin }, handshakeTimeout: 3000 });
  t.after(() => socket.terminate());
  await once(socket, "open");
  const received = once(socket, "message");
  socket.send(JSON.stringify({ type: "request", id: "session-readonly", method: "GET", path: "/api/info" }));
  const [data] = await received;
  const response = JSON.parse(data.toString()) as { type: string; id: string; status: number };
  assert.equal(response.type, "response");
  assert.equal(response.id, "session-readonly");
  assert.equal(response.status, 200);
  const closed = once(socket, "close"); socket.close(1000); await closed;
});

test("tampered, duplicated, expired and other-server sessions cannot authorize requests", { timeout: 15000 }, async t => {
  const server = await fixture(t);
  const other = await fixture(t);
  const { cookie } = await session(server.origin);
  for (const invalid of [cookie + "x", cookie + "; " + cookie]) {
    assert.equal((await fetch(server.origin + "/api/info", { headers: { cookie: invalid } })).status, 401);
    assert.equal(await rejectedSocket(server.origin, invalid), 401);
  }
  assert.equal((await fetch(other.origin + "/api/info", { headers: { cookie } })).status, 401);
  assert.equal((await fetch(server.origin + "/api/info", { headers: { cookie, authorization: "Basic " + Buffer.from("demo:wrong-password").toString("base64") } })).status, 401);
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() + 2 * 60 * 60 * 1000 });
  try { assert.equal((await fetch(server.origin + "/api/info", { headers: { cookie } })).status, 401); }
  finally { t.mock.timers.reset(); }
});
