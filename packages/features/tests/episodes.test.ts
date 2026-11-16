import test from "node:test";
import assert from "node:assert/strict";
import { parseSummary, summaryHasSecret, summaryPrompt } from "@assistant/features";

test("摘要解析：JSON、带前后缀的 JSON、非 JSON 回退、空输出", () => {
  assert.deepEqual(parseSummary('{"summary":"已提交","openItems":["周五回复"]}'), { summary: "已提交", openItems: ["周五回复"] });
  assert.equal(parseSummary('好的：\n```json\n{"summary":"带围栏","openItems":[]}\n```')?.summary, "带围栏");
  assert.deepEqual(parseSummary("模型直接说了一段话"), { summary: "模型直接说了一段话", openItems: [] });
  assert.equal(parseSummary("  "), null);
  assert.equal(parseSummary(`{"summary":"x","openItems":${JSON.stringify(Array.from({ length: 20 }, (_, i) => `事项${i}`))}}`)?.openItems.length, 8, "待跟进事项数量有上限");
});

test("含凭据的摘要被识别；提示词声明内容不可信", () => {
  assert.equal(summaryHasSecret({ summary: "正常内容", openItems: ["token: abcdef123456789"] }), true);
  assert.equal(summaryHasSecret({ summary: "正常内容", openItems: [] }), false);
  assert.match(summaryPrompt("某聊天", "用户：你好"), /不可信/);
});

test("recall exposes bounded candidates; read_episode explicitly delivers full provenance without asserting adoption", async () => {
  const { createEpisodes } = await import("@assistant/features");
  const row = { id: "stable-episode", source: "teams:chat:one", sourceRevision: 4, messageIds: ["chat:one:message-7"], label: "Synthetic", channel: "teams", level: 0 as const, periodStart: "2026-01-01", periodEnd: "2026-01-02", summary: "x".repeat(300), openItems: ["historical item"] };
  let reads = 0;
  const extension = createEpisodes({ search: async caller => { assert.equal(caller, 5); return [row]; }, read: async (caller, id, call) => { assert.deepEqual(call, { taskId: 1, callId: "call-1" }); assert.equal(caller, 5); reads++; return id === row.id ? row : undefined; }, openItems: () => [] });
  const api = { conversationId: 5, taskId: 1, callId: "call-1" } as never;
  const recall = extension.tools!.find(tool => tool.name === "recall")!;
  const read = extension.tools!.find(tool => tool.name === "read_episode")!;
  const candidate = JSON.stringify(await recall.execute({ query: "project" }, api, {} as never));
  assert.equal(reads, 0); assert.match(candidate, /stable-episode/); assert.doesNotMatch(candidate, new RegExp("x".repeat(161)));
  const full = JSON.stringify(await read.execute({ id: row.id }, api, {} as never));
  assert.equal(reads, 1); assert.match(full, new RegExp("x".repeat(300))); assert.match(full, /message-7/); assert.match(full, /teams_history/);
  assert.match(JSON.stringify(await read.execute({ id: "missing" }, api, {} as never)), /不存在、来源已失效/);
});

test("episode original locators use valid tool arguments and never invent missing message identity", async () => {
  const { episodeReferences } = await import("../dist/episodes/references.js");
  const row = { id: "episode", source: "conv:42", sourceRevision: 0, messageIds: ["7"], label: "label", channel: "web", level: 0 as const, periodStart: "2026-01-01", periodEnd: "2026-01-01", summary: "summary", openItems: [] };
  assert.deepEqual(episodeReferences(row).references, [{ tool: "read_conversation", arguments: { conversationId: 42, beforeEntryId: 8, limit: 1 } }]);
  assert.equal(episodeReferences(row).verified, false);
  assert.equal(episodeReferences({ ...row, messageIds: [] }).unavailable, true);
  assert.deepEqual(episodeReferences({ ...row, source: "teams:chat:one", messageIds: ["chat:one:message:7"] }).references, [{ tool: "teams_history", arguments: { chatId: "chat:one", messageId: "message:7" } }]);
  assert.equal(episodeReferences({ ...row, messageIds: Array.from({ length: 10 }, (_, index) => String(index + 1)) }).truncated, true);
});
