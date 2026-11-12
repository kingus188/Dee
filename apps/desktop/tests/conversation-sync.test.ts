import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { createModelCatalog, openRuntime } from "@assistant/runtime";
import type { DesktopConversation, DesktopConversationUpload } from "@assistant/contracts";
import { syncConversations, piConversation, peerSessionsForServer } from "../dist/conversation-sync.js";
import { openAgentSessionStore } from "../dist/agents/store.js";
import { openDesktopAgent } from "../dist/local-agent.js";
import { openAgentSettings } from "../dist/agent-settings.js";

test("empty session directories keep their original server binding across restart", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "dee-empty-session-sync-"));
  const catalog = await createModelCatalog({ api: "faux", apiKey: "", baseUrl: "", model: "", contextWindow: 128000, maxTokens: 8192 }, fauxAssistantMessage("unused"));
  const open = () => openRuntime({ dataDir, ...catalog, extensions: [], resume: false, onReport: () => {} }, ctx);
  let runtime = await open();
  const items = [{ agent: "claude" as const, sessionId: randomUUID(), status: "idle" }];
  try {
    assert.deepEqual(await peerSessionsForServer(runtime, "server-a", items), items);
    await runtime.harness.close(ctx); runtime = await open();
    assert.deepEqual(await peerSessionsForServer(runtime, "server-b", items), []);
    assert.deepEqual(await peerSessionsForServer(runtime, "server-a", items), items);
  } finally { await runtime.harness.close(ctx); await rm(dataDir, { recursive: true, force: true }); }
});

test("offline transcripts retry across restart with stable revisions and stay pinned to their server", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "dee-chat-sync-"));
  const catalog = await createModelCatalog({ api: "faux", apiKey: "", baseUrl: "", model: "", contextWindow: 128000, maxTokens: 8192 }, fauxAssistantMessage("已回复"));
  const open = () => openRuntime({ dataDir, ...catalog, extensions: [], resume: false, onReport: () => {} }, ctx);
  let runtime = await open();
  const deviceId = `desktop-${randomUUID()}`;
  const session: DesktopConversation = { sessionId: randomUUID(), agent: "codex", messages: [{ id: "question", role: "user", text: "需要保存的对话" }] };
  let online = false, confirmed = true;
  const uploads: DesktopConversationUpload[] = [];
  const request = async (path: string, body: DesktopConversationUpload, server: string) => {
    assert.equal(path, "/api/peers/conversations"); assert.equal(server, "server-a");
    uploads.push(structuredClone(body));
    if (!online) throw new Error("offline");
    return { revision: confirmed ? body.revision : body.revision - 1 };
  };
  const sync = (serverId = "server-a") => syncConversations({ runtime, deviceId, serverId, sessions: [structuredClone(session)], request });
  try {
    await assert.rejects(sync(), /offline/);
    assert.equal(uploads[0]!.revision, 1);
    await runtime.harness.close(ctx); runtime = await open();
    online = true;
    await sync("server-b"); assert.equal(uploads.length, 1, "never send an existing conversation to a different server");
    await sync(); assert.equal(uploads[1]!.revision, 1, "retry the same revision after restart");
    await sync(); assert.equal(uploads.length, 2, "unchanged conversations are not reuploaded");
    session.messages.push({ id: "answer", role: "assistant", text: "已执行" });
    confirmed = false; await assert.rejects(sync(), /未确认/);
    confirmed = true; await sync(); assert.equal(uploads[3]!.revision, 2); assert.equal(uploads[3]!.messages.length, 2);
    assert.deepEqual(Object.keys(uploads[3]!).sort(), ["agent", "deviceId", "messages", "revision", "sessionId"]);
  } finally { await runtime.harness.close(ctx); await rm(dataDir, { recursive: true, force: true }); }
});

test("desktop Pi sends its final reply to the server on close and does not duplicate it after restart", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dee-chat-agent-"));
  const settings = openAgentSettings(directory);
  const config = { api: "faux", apiKey: "", baseUrl: "", model: "faux-1", contextWindow: 128000, maxTokens: 8192 };
  const uploads: DesktopConversationUpload[] = [];
  const options = {
    directory, settings, serverId: () => "server-a", confirm: async () => false,
    loadModels: async () => ({ ...await createModelCatalog(config, fauxAssistantMessage("完整回答")), model: { ...config, hasApiKey: false } }),
    request: async (path: string, body?: unknown) => {
      if (path === "/api/info") return {};
      if (path.startsWith("/api/peers/tasks?")) return { items: [] };
      assert.equal(path, "/api/peers/conversations");
      const upload = structuredClone(body) as DesktopConversationUpload;
      uploads.push(upload); return { revision: upload.revision };
    },
  };
  let agent = await openDesktopAgent(options), closed = false;
  try {
    await agent.send({ id: randomUUID(), text: "保存这一轮" });
    const deadline = Date.now() + 10000;
    while ((await agent.snapshot()).busy && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal((await agent.snapshot()).busy, false);
    assert.ok((await agent.snapshot()).messages.some(message => message.role === "assistant" && message.text === "完整回答"), "the completed local turn must contain its answer before close");
    await agent.close(); closed = true;
    assert.deepEqual(uploads.at(-1)!.messages.map(message => message.text), ["保存这一轮", "完整回答"]);
    const count = uploads.length;
    agent = await openDesktopAgent(options); closed = false;
    await agent.close(); closed = true;
    assert.equal(uploads.length, count);
  } finally { if (!closed) await agent.close(); await rm(directory, { recursive: true, force: true }); }
});

test("Pi history retains messages before a context reset; external history includes old sessions without native credentials", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "dee-chat-history-"));
  const catalog = await createModelCatalog({ api: "faux", apiKey: "", baseUrl: "", model: "", contextWindow: 128000, maxTokens: 8192 }, fauxAssistantMessage("已回复"));
  const runtime = await openRuntime({ dataDir, ...catalog, extensions: [], onReport: () => {} }, ctx);
  try {
    await (await runtime.root.submit({ type: "input", content: "重置前的正文" }, ctx)).wait(ctx);
    await runtime.root.reset(undefined, ctx);
    await (await runtime.root.submit({ type: "input", content: "重置后的正文" }, ctx)).wait(ctx);
    const pi = await piConversation(runtime);
    assert.ok(pi.messages.some(message => message.role === "assistant"));
    assert.deepEqual(pi.messages.filter(message => message.role === "user").map(message => message.text), ["重置前的正文", "重置后的正文"]);
    const store = openAgentSessionStore(dataDir);
    const binding = JSON.stringify({ kind: "claude", cwd: "/private/workspace", config: { executable: "/private/bin/claude", args: [] } });
    const first = store.create(binding); first.nativeId = "native-private"; first.messages.push({ id: "u1", role: "user", text: "旧会话" }); store.persist();
    store.create(binding).messages.push({ id: "u2", role: "user", text: "新会话" }); store.persist();
    const history = openAgentSessionStore(dataDir).history();
    assert.deepEqual(history.map(item => item.messages[0]!.text), ["旧会话", "新会话"]);
    assert.ok(!JSON.stringify(history).includes("private"));
  } finally { await runtime.harness.close(ctx); await rm(dataDir, { recursive: true, force: true }); }
});
