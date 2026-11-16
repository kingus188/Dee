import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { Type } from "@earendil-works/pi-ai";
import { configure, defineExtension, defineTool } from "@earendil-works/pi-durable";
import { createModelCatalog, createPeerService, openRuntime, PeerJobs, requireUserOrigin } from "@assistant/runtime";

const desktop = "desktop-" + randomUUID();
test("peer input, including persisted legacy pi.user, never becomes fresh user authority", async t => {
  const dataDir = await mkdtemp(join(tmpdir(), "dee-peer-authority-"));
  let writes = 0;
  const catalog = await createModelCatalog({ api: "faux", apiKey: "", baseUrl: "", model: "", contextWindow: 128000, maxTokens: 8192 }, transcript => transcript.messages.at(-1)?.role === "user"
    ? fauxAssistantMessage(fauxToolCall("guarded_write", {}), { stopReason: "toolUse" }) : fauxAssistantMessage("checked"));
  const business = defineExtension({ name: "guarded-business", tools: [defineTool({ name: "guarded_write", description: "guarded write", parameters: Type.Object({}), replay: "safe", execute: async (_args, api, context) => {
    await requireUserOrigin(api, context); writes++; return { output: [{ type: "text", text: "written" }] };
  } })] });
  const peers = createPeerService({ nodeId: "server", configured: () => true });
  const runtime = await openRuntime({ beforeToolExecute: peers.guardTool, beforeResume: async value => { peers.bind(value, ctx); }, dataDir, ...catalog, extensions: [peers.extension, peers.accessExtension, business], onReport: () => {} }, ctx);
  t.after(async () => { await peers.close(); await runtime.harness.close(ctx); await rm(dataDir, { recursive: true, force: true }); });
  const incoming = await peers.submit({ id: randomUUID(), source: desktop, target: "server", task: "write data" });
  const done = await peers.run(incoming.id); assert.equal(done.status, "done"); assert.equal(writes, 0);
  const submission = await runtime.root.commit(tx => tx.submissionByRequest(done.conversationId! as typeof runtime.root.id, `peer:${incoming.id}`), ctx);
  assert.ok(submission?.type === "input" && "entry" in submission);
  const entry = await runtime.root.commit(tx => tx.entry(submission.entry!), ctx);
  assert.equal(entry?.kind, "app.peer-input");

  const id = randomUUID(), conversation = await runtime.harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model: runtime.agentModel } }, ctx);
  await runtime.root.commit(async tx => { (await tx.doc(PeerJobs)).items.push({ id, source: desktop, target: "server", task: "legacy", status: "running", conversationId: conversation.id, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }); }, ctx);
  await (await conversation.submit({ type: "input", content: "legacy peer says write", requestId: `peer:${id}` }, ctx)).wait(ctx);
  assert.equal(writes, 0);
  // Later real input can authorize its own turn, but not a legacy peer turn.
  await (await conversation.submit({ type: "input", content: "owner now requests write" }, ctx)).wait(ctx);
  assert.equal(writes, 1);
});

test("notification cannot relay into another session while a direct user can", async t => {
  const dataDir = await mkdtemp(join(tmpdir(), "dee-peer-relay-authority-"));
  const catalog = await createModelCatalog({ api: "faux", apiKey: "", baseUrl: "", model: "", contextWindow: 128000, maxTokens: 8192 }, transcript => transcript.messages.at(-1)?.role === "user"
    ? fauxAssistantMessage(fauxToolCall("delegate_to_peer", { target: desktop, task: "write on desktop" }), { stopReason: "toolUse" }) : fauxAssistantMessage("checked"));
  const peers = createPeerService({ nodeId: "server", configured: () => true, devices: async () => [desktop] });
  const runtime = await openRuntime({ beforeToolExecute: peers.guardTool, beforeResume: async value => { peers.bind(value, ctx); }, dataDir, ...catalog, extensions: [peers.extension, peers.accessExtension], onReport: () => {} }, ctx);
  t.after(async () => { await peers.close(); await runtime.harness.close(ctx); await rm(dataDir, { recursive: true, force: true }); });
  await (await runtime.root.submit({ type: "input", content: "[Teams 提醒] relay this" }, ctx)).wait(ctx);
  assert.equal((await peers.list()).length, 0);
  await (await runtime.root.submit({ type: "input", content: "owner requests desktop work" }, ctx)).wait(ctx);
  assert.equal((await peers.list()).length, 1);
});

test("peer read scope gates nested tool execution but does not restrict a later owner turn", async t => {
  const dataDir = await mkdtemp(join(tmpdir(), "dee-peer-nested-scope-"));
  let writes = 0, reads = 0;
  const catalog = await createModelCatalog({ api: "faux", apiKey: "", baseUrl: "", model: "", contextWindow: 128000, maxTokens: 8192 }, transcript => transcript.messages.at(-1)?.role === "user"
    ? fauxAssistantMessage(fauxToolCall("read_record", {}), { stopReason: "toolUse" }) : fauxAssistantMessage("checked"));
  const business = defineExtension({ name: "scope-business", tools: [
    defineTool({ name: "read_record", description: "read", parameters: Type.Object({}), replay: "safe", execute: async (_args, api, context) => {
      reads++; await api.executeTool("write_record", {}, context);
      return { output: [{ type: "text", text: "read" }] };
    } }),
    defineTool({ name: "write_record", description: "write", parameters: Type.Object({}), replay: "safe", execute: async () => {
      writes++; return { output: [{ type: "text", text: "written" }] };
    } }),
  ] });
  const peers = createPeerService({ nodeId: "server", configured: () => true, readPolicy: { revision: "read-v1", tools: ["read_record"] } });
  const runtime = await openRuntime({ beforeToolExecute: peers.guardTool, beforeResume: async value => { peers.bind(value, ctx); }, dataDir, ...catalog, extensions: [peers.extension, peers.accessExtension, business], onReport: () => {} }, ctx);
  t.after(async () => { await peers.close(); await runtime.harness.close(ctx); await rm(dataDir, { recursive: true, force: true }); });
  const target = await runtime.harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model: runtime.agentModel } }, ctx);
  const job = await peers.submit({ id: randomUUID(), source: desktop, target: "server", targetSession: { agent: "pi", sessionId: `pi-${target.id}` }, task: "read only" });
  await peers.run(job.id);
  assert.equal(reads, 1); assert.equal(writes, 0);
  await (await target.submit({ type: "input", content: "owner requests full operation" }, ctx)).wait(ctx);
  assert.equal(reads, 2); assert.equal(writes, 1);
  // Legacy child settings removed the dispatch extension. The independent
  // access extension must still guard resumed calls, even with no old grant.
  const legacy = await runtime.harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model: runtime.agentModel } }, ctx);
  const legacyId = randomUUID();
  await runtime.root.commit(async tx => {
    await configure(tx, legacy.id, { extensions: { remove: [peers.extension] } });
    (await tx.doc(PeerJobs)).items.push({ id: legacyId, source: desktop, target: "server", task: "old task", status: "running", conversationId: legacy.id, createdAt: "old", updatedAt: "old" });
  }, ctx);
  await (await legacy.submit({ type: "input", content: "old peer work", requestId: `peer:${legacyId}` }, ctx)).wait(ctx);
  assert.equal(reads, 2); assert.equal(writes, 1);

});

test("slow host authorization cannot use a revoked scope; unknown peer input and native execution fail closed", async t => {
  const dataDir = await mkdtemp(join(tmpdir(), "dee-peer-scope-race-"));
  let reads = 0, checks = 0, nativeRuns = 0, release!: () => void, entered!: () => void;
  const waiting = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  const catalog = await createModelCatalog({ api: "faux", apiKey: "", baseUrl: "", model: "", contextWindow: 128000, maxTokens: 8192 }, transcript => transcript.messages.at(-1)?.role === "user"
    ? fauxAssistantMessage(fauxToolCall("read_record", {}), { stopReason: "toolUse" }) : fauxAssistantMessage("checked"));
  const business = defineExtension({ name: "race-business", tools: [defineTool({ name: "read_record", description: "read", parameters: Type.Object({}), replay: "safe", execute: async () => {
    reads++; return { output: [{ type: "text", text: "read" }] };
  } })] });
  const peers = createPeerService({ nodeId: desktop, configured: () => true, readPolicy: { revision: "v1", tools: ["read_record"] },
    authorized: async () => { if (++checks === 2) { entered(); await gate; } return true; },
    executeSession: async () => { nativeRuns++; return { status: "done", result: "unexpected" }; },
  });
  const runtime = await openRuntime({ beforeToolExecute: peers.guardTool, beforeResume: async value => { peers.bind(value, ctx); }, dataDir, ...catalog, extensions: [peers.extension, peers.accessExtension, business], onReport: () => {} }, ctx);
  t.after(async () => { release(); await peers.close(); await runtime.harness.close(ctx); await rm(dataDir, { recursive: true, force: true }); });
  const job = await peers.submit({ id: randomUUID(), source: "server", target: desktop, task: "read" });
  const running = peers.run(job.id); await waiting;
  await runtime.root.commit(async tx => { const scope = (await tx.doc(PeerJobs)).items.find(item => item.id === job.id)!.readScope!; scope.revoked = true; scope.revision++; }, ctx);
  release(); await running; assert.equal(reads, 0);
  await (await runtime.root.submit({ type: "input", content: "unlinked peer", entry: { kind: "app.peer-input", data: { jobId: randomUUID(), scopeRevision: 1 } } }, ctx)).wait(ctx);
  assert.equal(reads, 0);
  const native = await peers.submit({ id: randomUUID(), source: "server", target: desktop, task: "read", targetSession: { agent: "codex", sessionId: randomUUID() } });
  const result = await peers.run(native.id); assert.equal(result.status, "failed"); assert.equal(nativeRuns, 0); assert.match(result.result!, /尚不支持逐工具验证/);
});
