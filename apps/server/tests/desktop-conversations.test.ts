import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { createModelCatalog, openRuntime } from "@assistant/runtime";
import { createApi } from "../dist/application/api.js";
import type { AppContext } from "../dist/application/context.js";
import { readConfig } from "../dist/config.js";
import { createHttpServer } from "../dist/http/server.js";
import { watchView } from "../dist/application/view-stream.js";
import type { ConversationView } from "@assistant/contracts";

for (const kind of ["codex", "omp"]) test(`${kind} desktop transcripts join server history, survive restart, deduplicate and cannot execute server tasks`, async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "dee-desktop-history-"));
  const catalog = await createModelCatalog({ api: "faux", apiKey: "", baseUrl: "", model: "", contextWindow: 128000, maxTokens: 8192 }, fauxAssistantMessage("已回复"));
  const open = () => openRuntime({ dataDir, ...catalog, extensions: [], onReport: () => {} }, ctx);
  let runtime = await open();
  const app = () => ({ ...runtime, ctx, config: { password: randomUUID() }, wechat: null, modelConfigured: true, episodeStore: { revokeSource() {} } } as unknown as AppContext);
  let api = createApi(app());
  const call = (method: string, path: string, body?: Record<string, unknown>) => api.dispatch(method, new URL(path, "http://localhost"), body);
  const upload = { deviceId: `desktop-${randomUUID()}`, sessionId: randomUUID(), agent: kind, revision: 1, messages: [{ id: "u1", role: "user", text: "本机问题" }, { id: "a1", role: "assistant", text: "本机回答" }] };
  try {
    const saved = await call("POST", "/api/peers/conversations", upload);
    const { id } = saved.data as { id: number };
    assert.deepEqual(await call("POST", "/api/peers/conversations", upload), saved);
    const history = (await call("GET", "/api/conversations")).data as Array<{ id: number; title: string; channel: string }>;
    assert.equal(history.length, 1);
    assert.equal(history[0]!.id, id); assert.equal(history[0]!.title, "本机问题"); assert.equal(history[0]!.channel, "desktop");
    const conversation = await api.conversations.getConversation(id), state = await conversation.viewState(ctx);
    try {
      const view = await api.views.simplifyView(conversation.id, state.value);
      assert.equal(view.readOnly, true); assert.equal(view.channel, "desktop");
      assert.deepEqual(view.entries.map(entry => entry.text), ["本机问题", "本机回答"]);
      assert.match(await api.tasks.exportMarkdown(conversation), /本机回答/);
    } finally { state.dispose(); }
    for (const action of ["messages", "fork", "abort", "goals", "schedules", "notes"]) await assert.rejects(call("POST", `/api/conversations/${id}/${action}`, { text: "不得执行" }), { status: 409 });
    for (const invalid of [{ ...upload, revision: 0 }, { ...upload, revision: 1.1 }, { ...upload, deviceId: "server" }, { ...upload, agent: ["pi"] }, { ...upload, agent: { toString: 1 } }, { ...upload, messages: [{ id: "bad", role: "tool", text: "x" }] }, { ...upload, messages: [upload.messages[0], upload.messages[0]] }]) await assert.rejects(call("POST", "/api/peers/conversations", invalid), { status: 400 });
    await assert.rejects(call("POST", "/api/peers/conversations", { ...upload, messages: [{ id: "u1", role: "user", text: "改写同版本" }] }), { status: 409 });
    upload.revision = 2; upload.messages.push({ id: "u2", role: "user", text: "第二轮" });
    const taskGraph = await runtime.harness.taskGraph(ctx), frames: ConversationView[] = [];
    let streamError: unknown;
    const stream = watchView({ ...app(), taskGraph }, api.views, conversation, async view => { frames.push(view); }, error => { streamError = error; });
    try {
      await stream.ready;
      await call("POST", "/api/peers/conversations", upload);
      const deadline = Date.now() + 5000;
      while (frames.at(-1)?.entries.length !== 3 && !streamError && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
      assert.equal(streamError, undefined);
      assert.equal(frames.at(-1)?.entries.at(-1)?.text, "第二轮", "an open server history receives later desktop changes");
    } finally { stream.close(); taskGraph.dispose(); }
    await assert.rejects(call("POST", "/api/peers/conversations", { ...upload, revision: 1 }), { status: 409 });
    const web = (await call("POST", "/api/conversations/direct")).data as { id: number };
    assert.notEqual(web.id, id, "opening web chat must not select a desktop archive");
    await runtime.harness.close(ctx); runtime = await open(); api = createApi(app());
    assert.deepEqual(await call("POST", "/api/peers/conversations", upload), { status: 200, data: { id, revision: 2 } });
    await call("POST", `/api/conversations/${id}/remove`);
    upload.revision = 3;
    assert.equal(((await call("POST", "/api/peers/conversations", upload)).data as { removed?: boolean }).removed, true);
    assert.ok(!((await call("GET", "/api/conversations")).data as Array<{ id: number }>).some(item => item.id === id));
  } finally { await runtime.harness.close(ctx); await rm(dataDir, { recursive: true, force: true }); }
});

test("HTTP transcript uploads require pairing and retain same-origin and input-size checks", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "dee-desktop-history-http-")), token = "c".repeat(43);
  const catalog = await createModelCatalog({ api: "faux", apiKey: "", baseUrl: "", model: "", contextWindow: 128000, maxTokens: 8192 }, fauxAssistantMessage("已回复"));
  const runtime = await openRuntime({ dataDir, ...catalog, extensions: [], onReport: () => {} }, ctx);
  const app = { ...runtime, ctx, config: readConfig({ NODE_ENV: "test", AUTH_DISABLED: "1", PEER_TOKEN: token }), wechat: null, exitIfFatal: () => {}, redact: String } as unknown as AppContext;
  const http = createHttpServer(app);
  await new Promise<void>(resolve => http.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(http.address() as AddressInfo).port}/api/peers/conversations`;
  const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  const body = { deviceId: `desktop-${randomUUID()}`, sessionId: "pi-1", agent: "pi", revision: 1, messages: [{ id: "u1", role: "user", text: "中".repeat(100000) }] };
  try {
    assert.equal((await fetch(url, { method: "POST", body: "{}" })).status, 401);
    assert.equal((await fetch(url, { method: "POST", headers: { ...headers, origin: "https://outside.invalid" }, body: JSON.stringify(body) })).status, 403);
    assert.equal((await fetch(url, { method: "POST", headers, body: JSON.stringify(body) })).status, 200, "transcripts can exceed the ordinary 100 KB API body limit");
    assert.equal((await fetch(url, { method: "POST", headers, body: JSON.stringify({ ...body, messages: [{ id: "x", role: "user", text: "a".repeat(1000001) }] }) })).status, 400);
  } finally {
    http.closeSockets(); http.closeAllConnections(); await new Promise<void>(resolve => http.close(() => resolve()));
    await runtime.harness.close(ctx); await rm(dataDir, { recursive: true, force: true });
  }
});
