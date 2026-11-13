import test from "node:test";
import assert from "node:assert/strict";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ToolExecutionApi, Tx } from "@earendil-works/pi-durable";
import { Delegate } from "../dist/tasks/delegation.js";

for (const success of [false, true]) test(`delegate persists ${success ? "done" : "failed"} consistently with the settled result`, async () => {
  const item = { conversationId: 8, task: "核对资料", status: "running" };
  const tx = {
    task: async () => ({ kind: "pi.tool", conversationId: 7, input: { kind: "model", assistant: 2, callId: "call" } }),
    entry: async (id: number) => id === 2 ? { id: 2, conversationId: 7, kind: "pi.assistant", model: [{ role: "assistant", content: [{ type: "toolCall", id: "call" }] }] } : { model: [{ content: [{ type: "text", text: "已核对" }] }] },
    scanEntries: async () => ({ items: [{ id: 1, conversationId: 7, kind: "pi.user", model: [{ role: "user", content: "请核对资料" }] }] }),
    conversation: async () => ({ id: 7 }),
    scanConversations: async () => ({ items: [{ id: 8 }] }),
    doc: async () => ({ items: [item] }),
  } as unknown as Tx;
  const api = { taskId: 10, callId: "call", conversationId: 7,
    commit: async <T>(fn: (tx: Tx) => Promise<T>) => fn(tx), details: async () => {},
    conversation: async () => ({ submit: async () => ({ wait: async () => success ? { status: "done", type: "input", answer: 3 } : { status: "unanswered", type: "input", reason: "model_failed" } }) }),
  } as unknown as ToolExecutionApi;
  const result = await Delegate.tools![0].execute({ task: "核对资料" }, api, BACKGROUND_CONTEXT);
  assert.equal(item.status, success ? "done" : "failed");
  assert.match(JSON.stringify(result), success ? /已核对/ : /没有完成.*model_failed/);
});
