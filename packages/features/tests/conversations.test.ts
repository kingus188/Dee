import test from "node:test";
import assert from "node:assert/strict";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ToolExecutionApi, Extension } from "@earendil-works/pi-durable";
import { createConversationTools } from "@assistant/features";

test("conversation query tools use host caller identity and propagate access failures", async () => {
  const calls: unknown[] = [];
  const extension: Extension = createConversationTools({ list: async (caller, query) => { calls.push([caller, query]); return { items: [] }; }, read: async () => { throw new Error("forbidden"); } });
  assert.deepEqual(extension.tools!.map(tool => tool.name), ["list_conversations", "read_conversation"]);
  const list = extension.tools![0];
  const query = { query: "Dee", archived: true, status: "completed" as const };
  await list.execute(query, { conversationId: 9 } as ToolExecutionApi, BACKGROUND_CONTEXT);
  assert.deepEqual(calls, [[9, query]]);
  assert.equal(list.replay, "safe");
  await assert.rejects(extension.tools![1].execute({ conversationId: 7 }, { conversationId: 9 } as ToolExecutionApi, BACKGROUND_CONTEXT), /forbidden/);
});
