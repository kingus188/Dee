import test from "node:test";
import assert from "node:assert/strict";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import type { Runtime } from "@assistant/runtime";
import { verifyEpisodeReadCall } from "../dist/episode-read-evidence.js";

test("read evidence binds real task, call, caller and assistant anchor, including nested calls", async () => {
  const tasks = new Map<number, unknown>([
    [10, { kind: "pi.tool", conversationId: 2, input: { kind: "model", assistant: 8, callId: "read" } }],
    [11, { kind: "pi.tool", conversationId: 2, input: { kind: "nested", parent: 10, parentCallId: "read", call: { id: "nested-read" } } }],
  ]);
  const tx = { task: async (id: number) => tasks.get(id),
    entry: async () => ({ id: 8, kind: "pi.assistant", conversationId: 2, model: [{ role: "assistant", content: [{ type: "toolCall", id: "read" }] }] }),
    scanEntries: async () => ({ items: [{ id: 7, kind: "pi.user", conversationId: 2 }] }),
  };
  const runtime = { root: { commit: async (fn: (tx: unknown) => unknown) => fn(tx) } } as unknown as Runtime;
  assert.deepEqual(await verifyEpisodeReadCall(runtime, ctx, 2, { taskId: 10, callId: "read" }), { callerId: 2, taskId: 10, callId: "read" });
  assert.deepEqual(await verifyEpisodeReadCall(runtime, ctx, 2, { taskId: 11, callId: "nested-read" }), { callerId: 2, taskId: 11, callId: "nested-read" });
  for (const call of [{ taskId: 10, callId: "forged" }, { taskId: 12, callId: "read" }, { taskId: 0, callId: "read" }, { taskId: 10, callId: "中".repeat(100) }]) {
    assert.equal(await verifyEpisodeReadCall(runtime, ctx, 2, call), undefined);
  }
  assert.equal(await verifyEpisodeReadCall(runtime, ctx, 3, { taskId: 10, callId: "read" }), undefined);
  tasks.set(11, { kind: "pi.tool", conversationId: 2, input: { kind: "nested", parent: 11, parentCallId: "nested-read", call: { id: "nested-read" } } });
  assert.equal(await verifyEpisodeReadCall(runtime, ctx, 2, { taskId: 11, callId: "nested-read" }), undefined);
  tx.scanEntries = async () => ({ items: [] });
  assert.equal(await verifyEpisodeReadCall(runtime, ctx, 2, { taskId: 10, callId: "read" }), undefined, "missing durable input is not evidence");
});

test("storage errors propagate instead of being reported as an unverified successful read", async () => {
  const runtime = { root: { commit: async () => { throw new Error("storage unavailable"); } } } as unknown as Runtime;
  await assert.rejects(verifyEpisodeReadCall(runtime, ctx, 2, { taskId: 10, callId: "read" }), /storage unavailable/);
});
