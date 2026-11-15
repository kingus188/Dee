import { createHttpServer } from "../dist/http/server.js";
import { readConfig } from "../dist/config.js";
import type { AppContext } from "../dist/application/context.js";
import type { AddressInfo } from "node:net";
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { createModelCatalog, createPeerService, openRuntime } from "@assistant/runtime";
import { peerApi } from "../dist/peer-api.js";
import { validateArtifact } from "../dist/peer-artifacts.js";

const device = `desktop-${randomUUID()}`;
const input = () => ({ id: randomUUID(), taskId: randomUUID(), deviceId: device, name: "result.txt", mimeType: "text/plain", size: 6, sha256: createHash("sha256").update("result").digest("hex"), data: Buffer.from("result").toString("base64") });
test("artifact boundary validates filename, bytes, canonical base64, digest and limits", () => {
  const valid = input(); assert.deepEqual(validateArtifact(valid), valid);
  for (const patch of [{ name: "../secret" }, { name: "x\r\ny" }, { mimeType: "text/html\n" }, { data: valid.data + "\n" }, { sha256: "0".repeat(64) }, { size: -1 }, { size: 1024 * 1024 + 1 }, { data: "" }]) assert.throws(() => validateArtifact({ ...valid, ...patch }));
});
test("artifact API requires completed execution target and persists verified idempotent results", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dee-artifacts-"));
  const catalog = await createModelCatalog({ api: "faux", apiKey: "", baseUrl: "", model: "", contextWindow: 128000, maxTokens: 8192 }, fauxAssistantMessage("done"));
  let peers = createPeerService({ nodeId: "server", configured: () => true });
  let runtime = await openRuntime({ dataDir: directory, ...catalog, extensions: [peers.extension], onReport: () => {} }, ctx); peers.bind(runtime, ctx);
  const context = () => ({ ...runtime, peers, ctx, config: { password: "test" }, exitIfFatal() {}, redact: String });
  const call = (method: string, path: string, body?: Record<string, unknown>) => peerApi(context(), method, new URL(`http://localhost/api/peers/${path}`), body);
  try {
    const job = await peers.submit({ id: randomUUID(), source: "server", target: device, task: "result" });
    const file = { ...input(), taskId: job.id }, path = `tasks/${job.id}/artifacts`;
    await assert.rejects(call("POST", path, file), { status: 409 });
    await peers.complete(job.id, { status: "done", result: "complete" });
    await assert.rejects(call("POST", path, { ...file, deviceId: `desktop-${randomUUID()}` }), { status: 404 });
    await call("POST", path, file); await call("POST", path, file);
    await assert.rejects(call("POST", path, { ...file, name: "changed" }), { status: 409 });
    const list = await call("GET", `${path}?deviceId=${device}`);
    assert.equal((list?.data as { items: unknown[] }).items.length, 1);
    assert.equal("data" in (list?.data as { items: object[] }).items[0], false);
    const downloaded = await call("GET", `${path}/${file.id}?deviceId=${device}`);
    assert.ok(downloaded && "item" in downloaded.data && downloaded.data.item && "data" in downloaded.data.item);
    assert.equal(downloaded.data.item.data, file.data);
    const http = createHttpServer({ ...context(), config: readConfig({ NODE_ENV: "test", LLM_API: "faux", DATA_DIR: directory, DEMO_PASSWORD: "test", NOTIFY_MODE: "off" }), wechat: null } as unknown as AppContext);
    await new Promise<void>(resolve => http.listen(0, "127.0.0.1", resolve));
    try {
      const origin = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
      const url = `${origin}/api/peers/${path}/${file.id}?deviceId=${device}&download=1`;
      assert.equal((await fetch(url)).status, 401);
      const response = await fetch(url, { headers: { authorization: "Basic " + Buffer.from("demo:test").toString("base64") } });
      assert.equal(response.status, 200); assert.equal(await response.text(), "result");
      assert.equal(response.headers.get("content-type"), "application/octet-stream");
      assert.match(response.headers.get("content-disposition")!, /^attachment;/);
      assert.equal(response.headers.get("x-content-type-options"), "nosniff");
      const listing = await fetch(`${origin}/api/peers/artifacts`, { headers: { authorization: "Basic " + Buffer.from("demo:test").toString("base64") } });
      assert.equal(listing.status, 200); assert.equal(((await listing.json()) as { items: unknown[] }).items.length, 1);
    } finally { http.closeSockets(); http.closeAllConnections(); await new Promise<void>(resolve => http.close(() => resolve())); }
    for (let i = 0; i < 4; i++) await call("POST", path, { ...file, id: randomUUID() });
    await assert.rejects(call("POST", path, { ...file, id: randomUUID() }), { status: 409 });
    await peers.close(); await runtime.harness.close(ctx);
    peers = createPeerService({ nodeId: "server", configured: () => true });
    runtime = await openRuntime({ dataDir: directory, ...catalog, extensions: [peers.extension], onReport: () => {} }, ctx); peers.bind(runtime, ctx);
    assert.equal(((await call("GET", `${path}?deviceId=${device}`))?.data as { items: unknown[] }).items.length, 5);
  } finally { await peers.close(); await runtime.harness.close(ctx); await rm(directory, { recursive: true, force: true }); }
});
