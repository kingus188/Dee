import test from "node:test";
import assert from "node:assert/strict";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ToolExecutionApi, Extension } from "@earendil-works/pi-durable";
import { createConversationTools } from "@assistant/features";

test("conversation query tools use host caller identity and propagate access failures", async () => {
  const calls: unknown[] = [];
  const extension: Extension = createConversationTools({ search: async (caller, query) => { calls.push([caller, query]); return { items: [], scanned: 0, nextCursor: null, warning: "" }; }, list: async (caller, query) => { calls.push([caller, query]); return { items: [] }; }, read: async () => { throw new Error("forbidden"); } });
  assert.deepEqual(extension.tools!.map(tool => tool.name), ["search_conversations", "list_conversations", "read_conversation"]);
  const list = extension.tools![1];
  const query = { query: "Dee", archived: true, status: "completed" as const };
  await list.execute(query, { conversationId: 9 } as ToolExecutionApi, BACKGROUND_CONTEXT);
  assert.deepEqual(calls, [[9, query]]);
  assert.equal(list.replay, "safe");
  await assert.rejects(extension.tools![2].execute({ conversationId: 7 }, { conversationId: 9 } as ToolExecutionApi, BACKGROUND_CONTEXT), /forbidden/);
});


test("exact conversation tool validates mutually exclusive modes before host reads", async () => {
  let calls = 0;
  const extension: Extension = createConversationTools({ search: async () => ({ items: [], scanned: 0, nextCursor: null, warning: "" }), list: async () => ({}), read: async (_caller, query) => { calls++; return query; } });
  const tool = extension.tools!.find(value => value.name === "read_conversation")!, api = { conversationId: 9 } as ToolExecutionApi;
  await assert.rejects(tool.execute({ conversationId: 7, messageId: "2" }, api, BACKGROUND_CONTEXT), /expectedSourceRevision/);
  await assert.rejects(tool.execute({ conversationId: 7, messageId: "2", expectedSourceRevision: 0, limit: 1 }, api, BACKGROUND_CONTEXT), /分页/);
  assert.equal(calls, 0);
  const output = JSON.stringify(await tool.execute({ conversationId: 7, messageId: "2", expectedSourceRevision: 0 }, api, BACKGROUND_CONTEXT));
  assert.match(output, /expectedSourceRevision/); assert.equal(calls, 1);
});
