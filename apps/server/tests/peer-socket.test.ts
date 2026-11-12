import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import WebSocket from "ws";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { createModelCatalog, createPeerService, openRuntime } from "@assistant/runtime";
import { createHttpServer } from "../dist/http/server.js";
import { readConfig } from "../dist/config.js";
import type { AppContext } from "../dist/application/context.js";

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
for (const authentication of ["peer-token", "basic"] as const) test(`peer WebSocket enforces pairing/origin/scope and pushes scoped durable jobs without browser cookies (${authentication})`, async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "dee-peer-ws-")), token = "w".repeat(43), deviceId = `desktop-${randomUUID()}`;
  const catalog = await createModelCatalog({ api: "faux", apiKey: "", baseUrl: "", model: "", contextWindow: 128000, maxTokens: 8192 }, fauxAssistantMessage("fixture"));
  const peers = createPeerService({ nodeId: "server", configured: () => true });
  const password = randomUUID();
  const authorization = authentication === "peer-token" ? `Bearer ${token}` : "Basic " + Buffer.from(`demo:${password}`).toString("base64");
  const runtime = await openRuntime({ dataDir, ...catalog, extensions: [peers.extension], onReport: () => {} }, ctx); peers.bind(runtime, ctx);
  const context = { ...runtime, peers, ctx, config: readConfig({ NODE_ENV: "test", ...(authentication === "peer-token" ? { AUTH_DISABLED: "1", PEER_TOKEN: token } : { DEMO_PASSWORD: password }) }), wechat: null, redact: String, exitIfFatal: () => {} } as unknown as AppContext;
  const http = createHttpServer(context); await new Promise<void>(resolve => http.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(http.address() as AddressInfo).port}`, url = origin.replace(/^http/, "ws") + "/api/peers/socket";
  const rejected = (headers: Record<string, string>, frame?: unknown) => new Promise<number>((resolve, reject) => {
    const socket = new WebSocket(url, { headers, handshakeTimeout: 3000 });
    socket.on("error", reject); socket.on("open", () => socket.send(JSON.stringify(frame ?? { type: "request", id: "unauthenticated", method: "GET", path: "/api/peers/devices" })));
    socket.on("close", code => resolve(code));
    socket.on("unexpected-response", (request, response) => { resolve(response.statusCode!); response.destroy(); request.destroy(); socket.terminate(); });
  });
  let socket: WebSocket | undefined;
  try {
    assert.equal(await rejected({ origin }), 1008);
    assert.equal(await rejected({ origin, authorization }), 1008, "handshake credentials alone cannot bypass application authentication");
    assert.equal(await rejected({ origin }, { type: "peer-auth", authorization: "Bearer wrong" }), 1008);
    assert.equal(await rejected({ origin: "https://other.invalid", authorization: `Bearer ${token}` }), 403);
    socket = new WebSocket(url, { headers: { origin } });
    const authenticated = new Promise<void>(resolve => socket!.on("message", bytes => { if (JSON.parse(String(bytes)).type === "peer-authenticated") resolve(); }));
    const events: unknown[] = [], pending = new Map<string, (value: { status: number; data?: unknown }) => void>(); let next = 0;
    socket.on("message", bytes => { const frame = JSON.parse(String(bytes)); if (frame.type === "event") events.push(frame); else { pending.get(frame.id)?.(frame); pending.delete(frame.id); } });
    const rpc = (path: string, body?: unknown) => new Promise<{ status: number; data?: unknown }>((resolve, reject) => {
      const id = String(++next), timer = setTimeout(() => { pending.delete(id); reject(new Error("RPC timed out")); }, 5000);
      pending.set(id, value => { clearTimeout(timer); resolve(value); });
      socket!.send(JSON.stringify({ type: "request", id, method: body === undefined ? "GET" : "POST", path, ...(body === undefined ? {} : { body }) }));
    });
    await once(socket, "open");
    socket.send(JSON.stringify({ type: "peer-auth", authorization })); await authenticated;
    assert.equal((await rpc("/api/conversations/direct", {})).status, 403);
    assert.equal((await rpc("/api/goals")).status, 403);
    assert.equal((await rpc(`/api/peers/tasks?deviceId=${deviceId}`)).status, 200);
    await wait(100); events.length = 0;
    await peers.submit({ id: randomUUID(), source: "server", target: `desktop-${randomUUID()}`, task: "another device" });
    await wait(100); assert.equal(events.length, 0, "other devices do not cause task disclosures or invalidations");
    const job = await peers.submit({ id: randomUUID(), source: "server", target: deviceId, task: "requires approval" });
    const deadline = Date.now() + 2000;
    while (!events.length && Date.now() < deadline) await wait(10);
    assert.deepEqual(events[0], { type: "event", event: "peer-tasks", data: { deviceId } });
    assert.equal((await peers.get(job.id))?.status, "queued");
    assert.equal((await runtime.harness.inspect(ctx)).tasks.length, 0, "push cannot execute an unapproved desktop task");
    const list = await rpc(`/api/peers/tasks?deviceId=${deviceId}`); assert.match(JSON.stringify(list.data), /requires approval/); assert.doesNotMatch(JSON.stringify(list.data), /another device/);
    const upload = { deviceId, sessionId: randomUUID(), agent: "codex", revision: 1, messages: [{ id: "u1", role: "user", text: "中".repeat(100000) }] };
    assert.equal((await rpc("/api/peers/conversations", upload)).status, 200, "transcripts retain their bounded upload capacity over WS");
    assert.equal((await rpc("/api/peers/conversations", upload)).status, 200, "unknown-result retry is idempotent");
  } finally {
    socket?.terminate(); http.closeSockets(); http.closeAllConnections(); await new Promise<void>(resolve => http.close(() => resolve()));
    await peers.close(); await runtime.harness.close(ctx); await rm(dataDir, { recursive: true, force: true });
  }
});
