import assert from "node:assert/strict";
import test from "node:test";
import type { ConversationId, ConversationView } from "@earendil-works/pi-durable";
import type { ViewEntry } from "@assistant/contracts";
import type { AppContext } from "../dist/application/context.js";
import { createViews } from "../dist/application/views.js";

const conversationId = 7 as ConversationId;
const views = createViews({
  harness: { snapshot: async () => undefined },
  taskGraph: { value: { tasks: {} } },
  redact: (text: unknown) => String(text).replace("private detail", "redacted"),
  teamsStore: { archive: {} },
} as unknown as AppContext);

async function simplify(entries: object[]) {
  return views.simplifyView(conversationId, {
    conversation: { id: conversationId, createdAt: "2026-11-06T12:00:00.000Z" },
    entries, docs: {},
  } as unknown as ConversationView);
}

test("conversation views preserve exact source timestamps without changing message content", async () => {
  const timestamps = [1793964600123, 1793964601456, 1793964602789];
  const input = [
    { id: 1, kind: "pi.user", model: [{ role: "user", content: "用户消息", timestamp: timestamps[0] }] },
    { id: 2, kind: "pi.assistant", model: [{ role: "assistant", timestamp: timestamps[1], stopReason: "error", errorMessage: "private detail", content: [
      { type: "text", text: "回复正文" }, { type: "thinking", thinking: "not visible" },
      { type: "toolCall", id: "call-1", name: "test_tool", arguments: { task: "test" } },
    ] }] },
    { id: 3, kind: "pi.tool-result", model: [{ role: "toolResult", timestamp: timestamps[2], toolCallId: "call-1", toolName: "test_tool", isError: true, content: [
      { type: "text", text: "<harness>[error] 工具失败</harness>" },
    ] }] },
  ];
  const before = structuredClone(input);
  const view = await simplify(input);
  assert.deepEqual(view.entries, [
    { id: 1, kind: "user", text: "用户消息", attachments: [], timestamp: timestamps[0] },
    { id: 2, kind: "assistant", text: "回复正文", toolCalls: [{ id: "call-1", name: "test_tool", args: { task: "test" } }], error: "redacted", timestamp: timestamps[1] },
    { id: 3, kind: "tool", text: "工具失败", toolCallId: "call-1", name: "test_tool", isError: true, timestamp: timestamps[2] },
  ]);
  assert.deepEqual(input, before, "display mapping must not rewrite persisted message data");
  assert.deepEqual((await simplify(input)).entries, view.entries, "repeated reads must not invent new timestamps");
});

test("legacy, invalid, and passive report entries remain undated", async () => {
  const invalid = [undefined, null, "1793964600123", "2026-11-06T12:00:00Z", NaN, Infinity, -Infinity, 8.64e15 + 1, -8.64e15 - 1];
  const input = invalid.flatMap((timestamp, index) => [
    { id: index * 3 + 1, kind: "pi.user", model: [{ role: "user", content: "旧用户消息", timestamp }] },
    { id: index * 3 + 2, kind: "pi.assistant", model: [{ role: "assistant", content: [{ type: "text", text: "旧回复" }], timestamp }] },
    { id: index * 3 + 3, kind: "pi.tool-result", model: [{ role: "toolResult", toolCallId: "legacy", toolName: "test_tool", content: [], timestamp }] },
  ]);
  const legacy: ViewEntry = { id: 100, kind: "assistant", text: "进度报告" };
  const view = await simplify([...input, { id: legacy.id, kind: "app.goal-report", data: { text: legacy.text } }]);
  assert.equal(view.entries.length, input.length + 1);
  assert.ok(view.entries.every(entry => !Object.hasOwn(entry, "timestamp")), "absence must stay absent, including before JSON serialization");
  assert.deepEqual(view.entries.at(-1), legacy);
  assert.ok(JSON.parse(JSON.stringify(view)).entries.every((entry: ViewEntry) => !("timestamp" in entry)));
});

test("recorded epoch and boundary timestamps are not replaced or inferred from entry order", async () => {
  const timestamps = [8.64e15, 0, -1, 1, -8.64e15];
  const view = await simplify(timestamps.map((timestamp, id) => ({
    id, kind: "pi.user", model: [{ role: "user", content: "原始时间", timestamp }],
  })));
  assert.deepEqual(view.entries.map(entry => entry.timestamp), timestamps);
  assert.deepEqual(view.entries.map(entry => entry.id), [0, 1, 2, 3, 4]);
});
