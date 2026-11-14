import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { createModelCatalog, createPeerService, openRuntime } from "@assistant/runtime";
import { peerApi, peerDevices } from "../dist/peer-api.js";
import { createHttpServer } from "../dist/http/server.js";
import type { AppContext } from "../dist/application/context.js";
import type { AddressInfo } from "node:net";
import { readConfig } from "../dist/config.js";
import { createApi } from "../dist/application/api.js";

test("HTTP peer routes retain authentication and same-origin checks", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "pi-peer-http-"));
  const password = randomUUID();
  const catalog = await createModelCatalog({ api: "faux", apiKey: "", baseUrl: "", model: "", contextWindow: 128000, maxTokens: 8192 }, fauxAssistantMessage("服务器完成"));
  const peers = createPeerService({ nodeId: "server", configured: () => true });
  const runtime = await openRuntime({ dataDir, ...catalog, extensions: [peers.extension], onReport: error => { throw error; } }, ctx);
  peers.bind(runtime, ctx);
  // Only peer dispatch is exercised; unrelated business services must never be called.
  const app = { ...runtime, peers, ctx, config: readConfig({ NODE_ENV: "test", LLM_API: "faux", PI_OFFLINE: "1", DATA_DIR: dataDir, PORT: "0", DEMO_PASSWORD: password, NOTIFY_MODE: "off" }), wechat: null, exitIfFatal: () => {}, redact: String } as unknown as AppContext;
  const http = createHttpServer(app);
  await new Promise<void>(resolve => http.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
  const headers = { authorization: "Basic " + Buffer.from(`demo:${password}`).toString("base64"), "content-type": "application/json" };
  try {
    const path = `/api/peers/tasks?deviceId=${device}`;
    assert.equal((await fetch(origin + path)).status, 401);
    const cancelPath = origin + `/api/peers/tasks/${randomUUID()}/cancel`;
    assert.equal((await fetch(cancelPath, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ deviceId: device }) })).status, 401);

    assert.equal((await fetch(origin + path, { headers })).status, 200);
    const input = { id: randomUUID(), source: device, target: "server", task: "服务器查询" };
    assert.equal((await fetch(origin + "/api/peers/tasks", { method: "POST", headers: { ...headers, origin: "https://outside.invalid" }, body: JSON.stringify(input) })).status, 403);
    assert.equal((await fetch(origin + "/api/peers/tasks", { method: "POST", headers, body: JSON.stringify({ ...input, source: "server" }) })).status, 400);
    assert.equal((await fetch(origin + "/api/peers/tasks", { method: "POST", headers, body: JSON.stringify(input) })).status, 202);
    assert.equal((await fetch(origin + `/api/peers/tasks/${input.id}?deviceId=${other}`, { headers })).status, 404);
  } finally {
    http.closeSockets(); http.closeAllConnections();
    await new Promise<void>((resolve, reject) => http.close(error => error ? reject(error) : resolve()));
    await peers.close(); await runtime.harness.close(ctx); await rm(dataDir, { recursive: true, force: true });
  }
});

const device = "desktop-" + randomUUID(), other = "desktop-" + randomUUID();
test("self-use webpages remain open while peer routes require independent pairing and preserve origin checks", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "pi-peer-paired-")), token = "c".repeat(43);
  const catalog = await createModelCatalog({ api: "faux", apiKey: "", baseUrl: "", model: "", contextWindow: 128000, maxTokens: 8192 }, fauxAssistantMessage("完成"));
  const peers = createPeerService({ nodeId: "server", configured: () => true });
  const runtime = await openRuntime({ dataDir, ...catalog, extensions: [peers.extension], onReport: () => {} }, ctx); peers.bind(runtime, ctx);
  const app = { ...runtime, peers, ctx, config: readConfig({ NODE_ENV: "test", AUTH_DISABLED: "1", PEER_TOKEN: token }), wechat: null, exitIfFatal: () => {}, redact: String } as unknown as AppContext;
  const http = createHttpServer(app); await new Promise<void>(resolve => http.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(http.address() as AddressInfo).port}`, path = `/api/peers/tasks?deviceId=${device}`;
  try {
    await assert.rejects(createApi(app).dispatch("GET", new URL(origin + "/api/peers/devices")), { status: 401 });
    assert.equal((await fetch(origin + path)).status, 401);
    assert.equal((await fetch(origin + path, { headers: { authorization: "Bearer wrong" } })).status, 401);
    assert.equal((await fetch(origin + path, { headers: { authorization: "Bearer " + token } })).status, 200);
    assert.equal((await fetch(origin + "/api/peers/tasks", { method: "POST", headers: { authorization: "Bearer " + token, origin: "https://outside.invalid", "content-type": "application/json" }, body: "{}" })).status, 403);
  } finally {
    http.closeSockets(); http.closeAllConnections(); await new Promise<void>(resolve => http.close(() => resolve()));
    await peers.close(); await runtime.harness.close(ctx); await rm(dataDir, { recursive: true, force: true });
  }
});
test("peer API validates routing, persists desktop waiting, and only accepts target completion", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "pi-peer-api-"));
  const catalog = await createModelCatalog({ api: "faux", apiKey: "", baseUrl: "", model: "", contextWindow: 128000, maxTokens: 8192 }, fauxAssistantMessage("服务器完成"));
  const peers = createPeerService({ nodeId: "server", configured: () => true });
  const runtime = await openRuntime({ dataDir, ...catalog, extensions: [peers.extension], onReport: error => { throw error; } }, ctx);
  peers.bind(runtime, ctx);
  const context = { ...runtime, peers, ctx, config: { password: randomUUID() }, exitIfFatal: () => {}, redact: String };
  const url = (path: string) => new URL("http://localhost/api/peers/" + path);
  const call = (method: string, path: string, body?: Record<string, unknown>) => peerApi(context, method, url(path), body);
  try {
    await assert.rejects(peerApi({ ...context, config: { password: "" } }, "GET", url(`tasks?deviceId=${device}`)), { status: 401 });
    await assert.rejects(call("GET", "tasks?deviceId=server"), { status: 400 });
    await call("GET", `tasks?deviceId=${device}`);
    assert.deepEqual((await peerDevices(runtime, ctx)).map(item => [item.deviceId, item.online]), [[device, true]]);
    const outbound = await peers.submit({ id: randomUUID(), source: "server", target: device, task: "等待本机确认" });
    await assert.rejects(call("GET", `tasks/${outbound.id}?deviceId=${other}`), { status: 404 });
    await assert.rejects(call("POST", `tasks/${outbound.id}/complete`, { deviceId: other, status: "done", result: "伪造" }), { status: 404 });
    const unrelated = await call("GET", `tasks?deviceId=${other}`);
    assert.ok(unrelated && "items" in unrelated.data && Array.isArray(unrelated.data.items));
    assert.equal(unrelated.data.items.length, 0);
    const cancelJob = await peers.submit({ id: randomUUID(), source: "server", target: device, task: "cancel offline" });
    await assert.rejects(call("POST", `tasks/${cancelJob.id}/cancel`, { deviceId: other }), { status: 404 });
    await call("POST", `tasks/${cancelJob.id}/cancel`, { deviceId: device });
    const pending = (await peers.get(cancelJob.id))!;
    assert.equal(pending.status, "queued");
    assert.ok(pending.cancellation?.requestedAt);
    assert.equal(pending.cancellation?.confirmedAt, undefined);
    await assert.rejects(call("POST", `tasks/${cancelJob.id}/complete`, { deviceId: device, status: "done", result: "bad", cancellationConfirmed: true }), { status: 400 });
    await call("POST", `tasks/${cancelJob.id}/complete`, { deviceId: device, status: "failed", result: "Stopped", cancellationConfirmed: true });
    assert.ok((await peers.get(cancelJob.id))?.cancellation?.confirmedAt);
    const result = { deviceId: device, status: "done", result: "本机结果" };
    const done = await call("POST", `tasks/${outbound.id}/complete`, result);
    assert.equal(done?.status, 200);
    assert.deepEqual(await call("POST", `tasks/${outbound.id}/complete`, result), done);
    await assert.rejects(call("POST", `tasks/${outbound.id}/complete`, { ...result, result: "不同" }), { status: 409 });
    const id = randomUUID(), input = { id, source: device, target: "server", task: "服务器业务", workspace: "/work/project", constraints: "Read only", acceptanceCriteria: "Report findings" };
    assert.equal((await call("POST", "tasks", input))?.status, 202);
    assert.equal((await peers.get(id))?.workspace, input.workspace);
    assert.equal((await peers.get(id))?.constraints, input.constraints);
    assert.equal((await peers.get(id))?.acceptanceCriteria, input.acceptanceCriteria);
    await peers.run(id);
    assert.equal((await peers.get(id))?.status, "done");
    await call("POST", "tasks", input);
    assert.equal((await peers.list()).filter(item => item.id === id).length, 1);
    await assert.rejects(call("POST", `tasks/${id}/complete`, result), { status: 403 });
    await assert.rejects(call("POST", "tasks", { ...input, source: "server" }), { status: 400 });
    await assert.rejects(call("POST", "tasks", { ...input, target: other }), { status: 400 });
    await assert.rejects(call("POST", "tasks", { ...input, task: "变更" }), { status: 409 });
    await assert.rejects(call("POST", "tasks", { ...input, task: "a".repeat(16_001) }), { status: 400 });
  } finally { await peers.close(); await runtime.harness.close(ctx); await rm(dataDir, { recursive: true, force: true }); }
});
