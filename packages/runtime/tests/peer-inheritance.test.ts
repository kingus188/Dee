import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { createModelCatalog, createPeerService, openRuntime, PeerJobs } from "@assistant/runtime";

for (const action of ["read", "write", "revoked"] as const) test(`two local delegate levels inherit the original peer scope: ${action}`, async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "dee-peer-inherit-"));
  let reads = 0, writes = 0;
  const children: Array<import("@earendil-works/pi-durable").ConversationId> = [];
  const id = randomUUID();
  const catalog = await createModelCatalog({ api: "faux", apiKey: "", baseUrl: "", model: "", contextWindow: 128000, maxTokens: 8192 }, transcript => {
    const last = transcript.messages.at(-1);
    if (last?.role === "toolResult") return fauxAssistantMessage("done");
    const text = last?.role === "user" && typeof last.content === "string" ? last.content : "";
    if (text === "child:0") return fauxAssistantMessage(fauxToolCall(action === "write" ? "write_record" : "read_record", {}), { stopReason: "toolUse" });
    return fauxAssistantMessage(fauxToolCall("legacy_read_delegate", { depth: text === "child:1" ? 0 : 1 }), { stopReason: "toolUse" });
  });
  const business = defineExtension({ name: "legacy-test-business", tools: [
    // Simulates a pre-upgrade local delegate; production policies do not grant
    // this helper or the real delegate tool to peer tasks.
    defineTool({ name: "legacy_read_delegate", description: "legacy fixture", parameters: Type.Object({ depth: Type.Number() }), replay: "safe", execute: async (args, api, context) => {
      const child = await api.commit(tx => tx.createConversation({ ownership: { kind: "task", taskId: api.taskId } }), context);
      children.push(child.id);
      if (action === "revoked" && args.depth === 0) await api.commit(async tx => { (await tx.doc(PeerJobs)).items.find(job => job.id === id)!.readScope!.revoked = true; }, context);
      const handle = (await api.conversation(child.id, context))!;
      await (await handle.submit({ type: "input", content: `child:${args.depth}`, requestId: `delegate:${api.taskId}` }, context)).wait(context);
      return { output: [{ type: "text", text: "finished" }] };
    } }),
    defineTool({ name: "read_record", description: "read", parameters: Type.Object({}), replay: "safe", execute: async () => { reads++; return { output: [] }; } }),
    defineTool({ name: "write_record", description: "write", parameters: Type.Object({}), replay: "safe", execute: async () => { writes++; return { output: [] }; } }),
  ] });
  const peers = createPeerService({ nodeId: "server", configured: () => true, readPolicy: { revision: "fixture-v1", tools: ["legacy_read_delegate", "read_record"] } });
  const runtime = await openRuntime({ dataDir, ...catalog, extensions: [peers.extension, business, peers.accessExtension], beforeToolExecute: peers.guardTool, beforeResume: async value => { peers.bind(value, ctx); }, onReport: () => {} }, ctx);
  try {
    await peers.submit({ id, source: "desktop-" + randomUUID(), target: "server", task: "read via local delegates" });
    await peers.run(id);
    assert.equal(reads, action === "read" ? 1 : 0); assert.equal(writes, 0);
    if (action === "read") {
      const childId = children.at(-1)!;
      const nextPeer = await peers.submit({ id: randomUUID(), source: "desktop-" + randomUUID(), target: "server", targetSession: { agent: "pi", sessionId: `pi-${childId}` }, task: "later peer cannot replace ancestor authority" });
      await peers.run(nextPeer.id);
      assert.equal(reads, 1, "later peer input remains bounded by the terminal ancestor scope");
      const child = (await runtime.harness.conversation(childId, ctx))!;
      await (await child.submit({ type: "input", content: "child:0" }, ctx)).wait(ctx);
      assert.equal(reads, 2, "a genuine later owner turn is independent, not permanently tainted");
    }
  } finally { await peers.close(); await runtime.harness.close(ctx); await rm(dataDir, { recursive: true, force: true }); }
});

test("a missing local owner task cannot become independent user authority", async () => {
  const { toolInputLineageInTx } = await import("../dist/user-origin.js");
  const task = { kind: "pi.tool", conversationId: 2, input: { kind: "model", assistant: 5, callId: "call" } };
  const tx = {
    task: async (id: number) => id === 10 ? task : undefined,
    entry: async () => ({ id: 5, conversationId: 2, kind: "pi.assistant", model: [{ role: "assistant", content: [{ type: "toolCall", id: "call" }] }] }),
    scanEntries: async () => ({ items: [{ id: 4, conversationId: 2, kind: "pi.user", model: [{ role: "user", content: "child task" }] }] }),
    conversation: async () => ({ owner: { taskId: 99, conversationId: 1 } }),
  } as unknown as import("@earendil-works/pi-durable").Tx;
  await assert.rejects(toolInputLineageInTx(tx, { taskId: 10, callId: "call", conversationId: 2 } as Parameters<typeof toolInputLineageInTx>[1]), /不能作为新的用户授权/);
});
