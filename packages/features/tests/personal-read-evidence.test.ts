import test from "node:test";
import assert from "node:assert/strict";
import type { Tx } from "@earendil-works/pi-durable";
import type { ToolOrigin } from "@assistant/runtime";
import { recordMemoryRead, MEMORY_READ_EVIDENCE_LIMIT, type MemoryReadReceipt } from "../dist/personal/read-evidence.js";

function fixture() {
  const doc = { items: [] as MemoryReadReceipt[] };
  const origin = { conversationId: 9, taskId: 10, callId: "read-call" } as ToolOrigin;
  const tx = {
    task: async () => ({ kind: "pi.tool", conversationId: origin.conversationId, input: { kind: "model", callId: origin.callId, assistant: 100 } }),
    entry: async () => ({ id: 100, kind: "pi.assistant", conversationId: origin.conversationId, model: [{ role: "assistant", content: [{ type: "toolCall", id: origin.callId, name: "read_memory" }] }] }),
    scanEntries: async () => ({ items: [{ id: 90, kind: "pi.user", conversationId: origin.conversationId }] }),
    doc: async () => doc,
  } as unknown as Tx;
  return { tx, doc, origin };
}
test("memory read evidence binds real anchor identity, item revision and original observation time", async () => {
  const { tx, doc, origin } = fixture();
  const first = await recordMemoryRead(tx, origin, "memory", 1);
  assert.equal(first.recorded, true);
  assert.deepEqual(await recordMemoryRead(tx, origin, "memory", 1), first);
  assert.equal(doc.items.length, 1);
  await recordMemoryRead(tx, origin, "memory", 2);
  Object.assign(origin, { taskId: 11 }); await recordMemoryRead(tx, origin, "memory", 2);
  assert.equal(doc.items.length, 3);
  assert.deepEqual(Object.keys(doc.items[0]).sort(), ["id", "kind", "conversationId", "taskId", "callId", "memoryId", "revision", "observedAt"].sort());
});
test("retired memory evidence prevents replay and delayed reads from renewing usage", async () => {
  const { tx, doc, origin } = fixture();
  const first = await recordMemoryRead(tx, origin, "memory", 1);
  for (let i = 1; i < MEMORY_READ_EVIDENCE_LIMIT; i++) { Object.assign(origin, { taskId: 10 + i }); await recordMemoryRead(tx, origin, "memory", 1); }
  Object.assign(origin, { taskId: origin.taskId + 1 });
  assert.equal((await recordMemoryRead(tx, origin, "memory", 1)).recorded, true);
  assert.equal(doc.items.length, MEMORY_READ_EVIDENCE_LIMIT);
  Object.assign(origin, { taskId: 10 });
  assert.deepEqual(await recordMemoryRead(tx, origin, "memory", 1), { recorded: false, reason: "outside_window" });
  assert.deepEqual(await recordMemoryRead(tx, origin, "never-read-before", 1), { recorded: false, reason: "outside_window" });
  assert.equal(first.recorded, true);
});
test("unverified anchors produce no durable evidence; database errors propagate", async () => {
  const { tx, doc, origin } = fixture();
  assert.deepEqual(await recordMemoryRead({ ...tx, task: async () => undefined } as Tx, origin, "memory", 1), { recorded: false, reason: "unverified_tool_origin" });
  assert.equal(doc.items.length, 0);
  await assert.rejects(recordMemoryRead({ ...tx, task: async () => { throw new Error("storage offline"); } } as Tx, origin, "memory", 1), /storage offline/);
});

test("real read_memory evidence survives reopen and only successful version reads are observed", { timeout: 15000 }, async () => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os"); const { join } = await import("node:path");
  const { BACKGROUND_CONTEXT: context } = await import("@earendil-works/chord/context");
  const { createModelCatalog, openRuntime } = await import("@assistant/runtime");
  const { fauxAssistantMessage, fauxToolCall } = await import("@earendil-works/pi-ai/providers/faux");
  const { createPersonal, proposeMemoryInTx, editMemoryInTx, decideMemoryInTx, MemoryReadEvidence, MemoryDoc } = await import("@assistant/features");
  const dir = await mkdtemp(join(tmpdir(), "dee-memory-read-receipt-"));
  let memoryId = "", origin: ToolOrigin | undefined;
  const extension = createPersonal({});
  const tools = extension.tools!.map(tool => tool.name !== "read_memory" ? tool : { ...tool,
    execute: async (args: unknown, api: Parameters<typeof tool.execute>[1], ctx: Parameters<typeof tool.execute>[2]) => {
      origin = { taskId: api.taskId, conversationId: api.conversationId, callId: api.callId };
      return tool.execute(args, api, ctx);
    } });
  const catalog = await createModelCatalog({ api: "faux", apiKey: "", baseUrl: "", model: "", contextWindow: 128000, maxTokens: 8192 }, transcript => {
    const last = transcript.messages.at(-1);
    if (last?.role === "user" && last.content === "list") return fauxAssistantMessage(fauxToolCall("list_memories", {}), { stopReason: "toolUse" });
    if (last?.role === "user" && last.content === "read") return fauxAssistantMessage(fauxToolCall("read_memory", { id: memoryId, revision: 1 }), { stopReason: "toolUse" });
    return fauxAssistantMessage("done");
  });
  const options = { dataDir: dir, ...catalog, extensions: [{ ...extension, tools }], onReport: () => {} };
  let runtime: Awaited<ReturnType<typeof openRuntime>> | undefined;
  try {
    runtime = await openRuntime(options, context);
    const conversation = await runtime.harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model: catalog.agentModel } }, context);
    const memory = await conversation.commit(tx => proposeMemoryInTx(tx, { text: "confirmed preference", source: "user", approved: true }), context);
    memoryId = memory.id;
    await (await conversation.submit({ type: "input", content: "list" }, context)).wait(context);
    assert.equal((await runtime.harness.snapshot(MemoryReadEvidence, conversation.id, context))?.items.length ?? 0, 0);
    await (await conversation.submit({ type: "input", content: "read" }, context)).wait(context);
    const receipt = (await runtime.harness.snapshot(MemoryReadEvidence, conversation.id, context))!.items[0];
    assert.equal(receipt.kind, "explicit_read"); assert.equal(receipt.memoryId, memoryId);
    assert.equal(receipt.callId, origin!.callId); assert.equal(receipt.taskId, origin!.taskId);
    await runtime.harness.close(context); runtime = undefined;
    runtime = await openRuntime(options, context);
    const restored = (await runtime.harness.conversation(conversation.id, context))!;
    assert.deepEqual(await restored.commit(tx => recordMemoryRead(tx, origin!, memoryId, 1), context), { recorded: true, receipt });
    assert.equal((await runtime.harness.snapshot(MemoryReadEvidence, conversation.id, context))!.items.length, 1);
    const before = (await runtime.harness.snapshot(MemoryDoc, context))!.items[0];
    assert.equal(before.decidedAt, memory.decidedAt); assert.equal(before.revision, 1);
    await restored.commit(tx => editMemoryInTx(tx, memoryId, "updated preference"), context);
    await (await restored.submit({ type: "input", content: "read" }, context)).wait(context);
    assert.equal((await runtime.harness.snapshot(MemoryReadEvidence, conversation.id, context))!.items.length, 1, "stale reads cannot record evidence");
    await restored.commit(tx => decideMemoryInTx(tx, memoryId, "reject"), context);
    await (await restored.submit({ type: "input", content: "read" }, context)).wait(context);
    assert.equal((await runtime.harness.snapshot(MemoryReadEvidence, conversation.id, context))!.items.length, 1, "revoked reads cannot record evidence");
  } finally { await runtime?.harness.close(context); await rm(dir, { recursive: true, force: true }); }
});

test("retirement drops an entire task group and rejects oversized provider call IDs without writing", async () => {
  const { tx, doc, origin } = fixture();
  await recordMemoryRead(tx, origin, "one", 1);
  await recordMemoryRead(tx, origin, "two", 1);
  for (let i = 0; i < MEMORY_READ_EVIDENCE_LIMIT - 2; i++) {
    Object.assign(origin, { taskId: 20 + i }); await recordMemoryRead(tx, origin, "one", 1);
  }
  Object.assign(origin, { taskId: 1000 }); await recordMemoryRead(tx, origin, "one", 1);
  assert.equal(doc.items.length, MEMORY_READ_EVIDENCE_LIMIT - 1);
  Object.assign(origin, { taskId: 10 });
  assert.deepEqual(await recordMemoryRead(tx, origin, "two", 1), { recorded: false, reason: "outside_window" });
  const before = JSON.stringify(doc);
  Object.assign(origin, { taskId: 1001, callId: "x".repeat(513) });
  assert.deepEqual(await recordMemoryRead(tx, origin, "one", 1), { recorded: false, reason: "unverified_tool_origin" });
  assert.equal(JSON.stringify(doc), before);
});
