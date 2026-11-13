import test from "node:test";
import assert from "node:assert/strict";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Index, type Runtime } from "@assistant/runtime";
import { WechatState } from "@assistant/channel-wechat";
import { DesktopTranscript } from "../dist/desktop-conversations.js";
import { createConversationReader } from "../dist/conversation-reader.js";

type Item = { id: number; title: string; createdAt: string; channel?: string; archivedAt?: string | null; archivingAt?: string | null; status?: "active" | "waiting" | "completed" };
function fixture() {
  const items: Item[] = [2, 3, 4, 5, 6, 7].map(id => ({ id, title: `对话${id}`, createdAt: "2026-01-01" }));
  items[1].channel = "teams"; items[2].channel = "wechat"; items[3].archivedAt = "2026-02-01"; items[3].status = "completed";
  const revoked = new Set<string>(), bound = new Set<number>([6]);
  let changed: (() => void) | undefined;
  let desktop: unknown = null;
  const rows = [
    { id: 5, kind: "pi.assistant", model: [{ role: "assistant", content: [{ type: "thinking", thinking: "hidden" }, { type: "text", text: "answer" }, { type: "toolCall", name: "tool", arguments: { token: "secret" } }], timestamp: 10 }] },
    { id: 4, kind: "pi.tool-result", model: [{ role: "toolResult", content: [{ type: "text", text: "tool secret" }] }] },
    { id: 3, kind: "pi.user", model: [{ role: "user", content: "password: synthetic-test", timestamp: 9 }] },
    { id: 2, kind: "pi.user", model: [{ role: "user", content: "正常".repeat(2000), timestamp: 8 }] },
  ];
  const runtime = { root: { id: 1 }, harness: {
    snapshot: async (doc: unknown) => doc === Index ? { items } : doc === WechatState ? { bindings: Object.fromEntries([...bound].map(id => [id, { conversationId: id }])) } : doc === DesktopTranscript ? { value: desktop } : undefined,
    conversation: async () => ({ entries: async (query: { maxEntryId?: number }, limit: number) => {
      changed?.();
      const selected = rows.filter(row => query.maxEntryId === undefined || row.id <= query.maxEntryId);
      return { items: selected.slice(0, limit), next: selected.length > limit ? "next" : undefined };
    } }),
  } } as unknown as Runtime;
  const reader = createConversationReader(runtime, BACKGROUND_CONTEXT, { sourceAllowed: (source, _rev, messages = []) => !revoked.has(source) && !messages.some(id => revoked.has(`${source}:${id}`)), sourceRevision: () => 0 });
  return { reader, items, revoked, bound, onRead: (fn: () => void) => { changed = fn; }, desktop: (value: unknown) => { desktop = value; } };
}

test("list filters private registered conversations, legacy status, archive and bounded pagination", async () => {
  const { reader } = fixture();
  assert.deepEqual((await reader.list(2, { limit: 1 }) as any).items.map((item: Item) => item.id), [7]);
  const first = await reader.list(2, { limit: 1 }) as any;
  assert.equal(first.nextBeforeId, 7);
  const second = await reader.list(2, { beforeId: first.nextBeforeId }) as any;
  assert.equal(second.items[0].status, "active");
  assert.deepEqual(second.items.map((item: Item) => item.id), [2]);
  assert.equal((await reader.list(2, { archived: true, status: "completed" }) as any).items[0].id, 5);
  await assert.rejects(reader.list(2, { limit: 10000 }), /1～50/);
});

test("external, bound, root, internal and removed callers cannot read private history", async () => {
  const { reader, revoked } = fixture();
  for (const caller of [1, 3, 4, 5, 6, 999]) await assert.rejects(reader.list(caller, {}), /不能查询/);
  for (const target of [1, 3, 4, 6, 999]) await assert.rejects(reader.read(2, { conversationId: target }), /不可查询/);
  revoked.add("conv:7");
  await assert.rejects(reader.read(2, { conversationId: 7 }), /不可查询/);
});

test("read returns bounded chronological text and provenance without tools, thinking or secrets", async () => {
  const { reader } = fixture();
  const first = await reader.read(2, { conversationId: 7, limit: 2 }) as any;
  assert.equal(first.nextBeforeEntryId, 4);
  assert.deepEqual(first.messages.map((message: any) => message.text), ["answer"]);
  const second = await reader.read(2, { conversationId: 7, beforeEntryId: 4, limit: 2 }) as any;
  assert.equal(second.messages[0].text.length, 2000);
  assert.equal(second.messages[0].truncated, true);
  assert.equal(second.messages[1].messageId, "3");
  assert.match(second.messages[1].text, /已省略/);
  assert.doesNotMatch(JSON.stringify([first.messages, second.messages]), /hidden|tool secret|synthetic-test/);
});

test("read rechecks removal and legacy channel binding before returning", async () => {
  for (const change of ["remove", "bind", "revoke"]) {
    const f = fixture();
    f.onRead(() => { if (change === "remove") f.items.splice(f.items.findIndex(item => item.id === 7), 1); else if (change === "bind") f.bound.add(7); else f.revoked.add("conv:7"); });
    await assert.rejects(f.reader.read(2, { conversationId: 7 }), /访问范围已变化/);
  }
});

test("desktop transcript pagination and message tombstones retain source identifiers", async () => {
  const f = fixture(); f.items.at(-1)!.channel = "desktop";
  f.desktop({ messages: [{ id: "a", role: "user", text: "hello" }, { id: "b", role: "assistant", text: "world" }] });
  const first = await f.reader.read(2, { conversationId: 7, limit: 1 }) as any;
  assert.equal(first.nextBeforeEntryId, 2);
  assert.equal(first.messages[0].messageId, "b");
  f.revoked.add("conv:7:a");
  const second = await f.reader.read(2, { conversationId: 7, beforeEntryId: 2 }) as any;
  assert.deepEqual(second.messages, []);
});

 test("archiving callers lose query access before execution stops", async () => {
  const f = fixture(); f.items[0].archivingAt = "2026-01-01";
  await assert.rejects(f.reader.list(2, {}), /不能查询/);
  await assert.rejects(f.reader.read(2, { conversationId: 7 }), /不能查询/);
});

test("reader queries actual SQLite conversation entries and survives reopening", async () => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { createModelCatalog, openRuntime } = await import("@assistant/runtime");
  const { fauxAssistantMessage } = await import("@earendil-works/pi-ai/providers/faux");
  const dataDir = await mkdtemp(join(tmpdir(), "dee-conversation-query-"));
  const catalog = await createModelCatalog({ api: "faux", apiKey: "", baseUrl: "", model: "", contextWindow: 128000, maxTokens: 8192 }, () => fauxAssistantMessage("recorded reply"));
  const options = { dataDir, ...catalog, extensions: [], onReport: () => {} };
  let runtime = await openRuntime(options, BACKGROUND_CONTEXT);
  try {
    const conversation = await runtime.harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model: runtime.agentModel }, init: async (tx, id) => { (await tx.doc(Index)).items.push({ id, title: "persistent", createdAt: "2026-01-01" }); } }, BACKGROUND_CONTEXT);
    await (await conversation.submit({ type: "input", content: "recorded question" }, BACKGROUND_CONTEXT)).wait(BACKGROUND_CONTEXT);
    const id = conversation.id;
    await runtime.harness.close(BACKGROUND_CONTEXT);
    runtime = await openRuntime(options, BACKGROUND_CONTEXT);
    const reader = createConversationReader(runtime, BACKGROUND_CONTEXT, { sourceAllowed: () => true, sourceRevision: () => 0 });
    const result = await reader.read(id, { conversationId: id }) as any;
    assert.deepEqual(result.messages.map((message: any) => [message.role, message.text]), [["user", "recorded question"], ["assistant", "recorded reply"]]);
    const first = await reader.read(id, { conversationId: id, limit: 1 }) as any;
    assert.ok(first.nextBeforeEntryId);
    const second = await reader.read(id, { conversationId: id, limit: 1, beforeEntryId: first.nextBeforeEntryId }) as any;
    assert.ok(second.messages.length || second.nextBeforeEntryId, "bounded entry pagination must advance across internal entries");
  } finally { await runtime.harness.close(BACKGROUND_CONTEXT); await rm(dataDir, { recursive: true, force: true }); }
});
