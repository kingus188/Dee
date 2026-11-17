import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createModelCatalog, openRuntime, Index } from "@assistant/runtime";
import { createEpisodes, createConversationTools, type EpisodeReader, type ConversationReader, type ConversationRead } from "@assistant/features";
import { createEpisodeReader } from "../dist/episode-reader.js";
import { createConversationReader } from "../dist/conversation-reader.js";
import { openEpisodeStore } from "../dist/episode-store.js";
import { DesktopTranscript } from "../dist/desktop-conversations.js";

const CASES = [
  { label: "original", text: "项目预算是30。", summary: "自动摘要称预算99（特意构造摘要错误）。" },
  { label: "late-correction", text: "更正上一条，预算应为20。", summary: "晚到更正提到了另一数值。" },
  { label: "future-effective-quote", text: "从2027年1月1日起执行新价格50，此前仍为40。", summary: "记录包含明确未来生效原话。" },
  { label: "unknown-effective-date", text: "新方案已经讨论，尚未确定何时执行。", summary: "没有明确生效日期。" },
] as const;
type Evidence = { messages: Array<{ messageId: string; text: string; truncated: boolean }>; exactMatch?: { identityMatched: boolean; status: string }; sourceRevision?: number };

test("精确原文闭环固定评测核对身份和原话，不自动判定更正关系或生效日期", async t => {
  const dir = await mkdtemp(join(tmpdir(), "dee-original-evidence-eval-"));
  const store = openEpisodeStore(dir);
  let episodes: ReturnType<typeof createEpisodeReader>, originals: ReturnType<typeof createConversationReader>;
  let target = "", followReferences = false;
  const evidence: Evidence[] = [], queries: ConversationRead[] = [];
  const episodeAdapter: EpisodeReader = { search: (...args) => episodes.search(...args), read: (...args) => episodes.read(...args), openItems: (...args) => episodes.openItems(...args) };
  const originalAdapter: ConversationReader = { list: (...args) => originals.list(...args), search: (...args) => originals.search(...args), read: async (...args) => {
    queries.push(args[1]); const value = await originals.read(...args); evidence.push(value as Evidence); return value;
  } };
  const { models, agentModel } = await createModelCatalog({ api: "faux", apiKey: "", baseUrl: "", model: "", contextWindow: 128000, maxTokens: 8192 }, transcript => {
    const last = transcript.messages.at(-1);
    if (followReferences && last?.role === "user") return fauxAssistantMessage(fauxToolCall("read_episode", { id: target }), { stopReason: "toolUse" });
    if (followReferences && last?.role === "toolResult" && last.toolName === "read_episode") {
      const text = last.content.filter(part => part.type === "text").map(part => part.text).join("");
      const result = JSON.parse(text) as { original: { references: Array<{ tool: string; arguments: Record<string, string | number> }> } };
      const reference = result.original.references[0];
      if (!reference) throw new Error("episode did not supply an exact source reference");
      return fauxAssistantMessage(fauxToolCall(reference.tool, reference.arguments), { stopReason: "toolUse" });
    }
    return fauxAssistantMessage("synthetic replay finished");
  });
  const runtime = await openRuntime({ dataDir: dir, models, agentModel, extensions: [createEpisodes(episodeAdapter), createConversationTools(originalAdapter)], onReport: error => { throw error; } }, ctx);
  try {
    const owner = await runtime.harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model: agentModel } }, ctx);
    const desktop = await runtime.harness.createConversation({ ownership: { kind: "ownerless" } }, ctx);
    await owner.commit(async tx => { (await tx.doc(Index)).items.push({ id: owner.id, title: "fixture", createdAt: "2026-11-17" }, { id: desktop.id, title: "desktop fixture", channel: "desktop", createdAt: "2026-11-17" }); }, ctx);
    episodes = createEpisodeReader(runtime, ctx, store, { offline: () => true, teams: { canReadEpisodeSource: async () => false } });
    originals = createConversationReader(runtime, ctx, store);
    const expected = new Map<string, string>();
    for (const item of CASES) {
      const submission = await owner.submit({ type: "input", content: item.text }, ctx); await submission.wait(ctx);
      const page = await owner.entries({}, 100, undefined, ctx);
      const row = page.items.find(entry => {
        const content = entry.model?.[0]?.content;
        const text = typeof content === "string" ? content : Array.isArray(content) ? content.filter(part => part.type === "text").map(part => part.text).join("") : "";
        return entry.kind === "pi.user" && text === item.text;
      });
      assert.ok(row); expected.set(item.label, String(row.id));
      assert.equal(store.add({ source: `conv:${owner.id}`, label: item.label, channel: "web", summary: item.summary, messageIds: [String(row.id)], sourceRevision: 0,
        periodStart: "2026-01-01T00:00:00Z", periodEnd: "2026-01-01T00:00:00Z", openItems: [] }), true);
    }
    followReferences = true;
    for (const item of CASES) {
      target = store.all().find(row => row.label === item.label)!.id;
      const submission = await owner.submit({ type: "input", content: "Read the synthetic summary then its exact original locator." }, ctx); await submission.wait(ctx);
      const result = evidence.at(-1)!;
      assert.equal(result.messages.length, 1); assert.equal(result.messages[0]!.messageId, expected.get(item.label));
      assert.equal(result.messages[0]!.text, item.text); assert.equal(result.messages[0]!.truncated, false);
      assert.equal(result.exactMatch?.identityMatched, true);
      const query = queries.at(-1)!;
      assert.equal(query.messageId, expected.get(item.label)); assert.equal(query.expectedSourceRevision, 0);
      assert.equal(query.limit, undefined); assert.equal(query.beforeEntryId, undefined);
    }
    assert.equal(evidence.length, 4);
    const absent = await originals.read(owner.id, { conversationId: owner.id, messageId: "99999999", expectedSourceRevision: 0 });
    assert.deepEqual(absent.messages, []); assert.equal(absent.exactMatch?.identityMatched, false);
    // Actual desktop persistence uses IDs unrelated to positions. Duplicate IDs
    // across roles are ambiguous, not permission to choose an arbitrary message.
    await owner.commit(async tx => { (await tx.doc(DesktopTranscript, desktop.id)).value = { deviceId: "fixture", sessionId: "fixture", agent: "codex", revision: 1,
      messages: [{ id: "opaque-target", role: "user", text: "精确桌面原话" }, { id: "2", role: "assistant", text: "不是第二个位置的替代原文" }, { id: "duplicate", role: "user", text: "歧义一" }, { id: "duplicate", role: "assistant", text: "歧义二" }] }; }, ctx);
    const desktopExact = await originals.read(owner.id, { conversationId: desktop.id, messageId: "opaque-target", expectedSourceRevision: 0 });
    assert.equal(desktopExact.messages[0]?.messageId, "opaque-target"); assert.equal(desktopExact.messages[0]?.text, "精确桌面原话");
    const missingDesktop = await originals.read(owner.id, { conversationId: desktop.id, messageId: "1", expectedSourceRevision: 0 });
    assert.deepEqual(missingDesktop.messages, []);
    // Both rejection styles are valid fail-closed outcomes; neither may expose a
    // member of the ambiguous pair as verified source evidence.
    let ambiguousReturned = 0;
    try { ambiguousReturned = (await originals.read(owner.id, { conversationId: desktop.id, messageId: "duplicate", expectedSourceRevision: 0 })).messages.length; }
    catch (error) { assert.match(String(error), /歧义|重复|无法|不唯一/); }
    assert.equal(ambiguousReturned, 0);
    store.revokeSource(`conv:${owner.id}`, expected.get("original"));
    await assert.rejects(originals.read(owner.id, { conversationId: owner.id, messageId: expected.get("late-correction")!, expectedSourceRevision: 0 }), /版本|变化|失效/);
    const currentRevision = store.sourceRevision(`conv:${owner.id}`);
    const revoked = await originals.read(owner.id, { conversationId: owner.id, messageId: expected.get("original")!, expectedSourceRevision: currentRevision });
    assert.deepEqual(revoked.messages, []);
    assert.equal(await episodes.read(owner.id, target), undefined, "old episode revision cannot silently bind current originals");
    t.diagnostic(JSON.stringify({ version: "synthetic-exact-original-v1", sdkChains: CASES.length, exactIdentityHits: evidence.length, exactIdentityTotal: CASES.length,
      summaryMismatchPreserved: true, missingNativeNeighborsReturned: absent.messages.length, missingDesktopNeighborsReturned: missingDesktop.messages.length, ambiguousReturned,
      oldRevisionRejected: true, revokedReturned: revoked.messages.length, returnedTextChars: evidence.reduce((sum, item) => sum + item.messages.reduce((n, message) => n + message.text.length, 0), 0),
      toolCalls: queries.length + CASES.length, meaning: "identity and quoted text only; fact validity, future effective interpretation, supersession and conflict resolution not evaluated",
      realModelAccuracy: "not measured (faux tool orchestration)", realTokens: "not measured", monetaryCost: "not measured" }));
  } finally { await runtime.harness.close(ctx); store.close(); await rm(dir, { recursive: true, force: true }); }
});
