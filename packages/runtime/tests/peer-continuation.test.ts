import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { configure } from "@earendil-works/pi-durable";
import { createModelCatalog, createPeerService, openRuntime, PeerJobs } from "@assistant/runtime";

async function until(ready: () => Promise<boolean>) {
  const deadline = Date.now() + 3000;
  while (!await ready()) { if (Date.now() > deadline) throw new Error("continuation timeout"); await new Promise(resolve => setTimeout(resolve, 5)); }
}

test("a completed source turn automatically continues in its original Pi context exactly once after target completion and restart", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "dee-peer-continuation-"));
  const turns: string[] = [];
  const catalog = await createModelCatalog({ api: "faux", apiKey: "", baseUrl: "", model: "", contextWindow: 128000, maxTokens: 8192 }, transcript => {
    turns.push(JSON.stringify(transcript.messages));
    return fauxAssistantMessage("continued");
  });
  const options = { dataDir, ...catalog, onReport: () => {} };
  let peers = createPeerService({ nodeId: "server", configured: () => true });
  let runtime = await openRuntime({ ...options, extensions: [peers.extension] }, ctx); peers.bind(runtime, ctx);
  try {
    const source = await runtime.root.commit(async tx => { const child = await tx.createConversation({ ownership: { kind: "ownerless" } }); await configure(tx, child.id, { model: runtime.agentModel }); return child.id; }, ctx);
    const conversation = (await runtime.harness.conversation(source, ctx))!;
    await (await conversation.submit({ type: "input", content: "source original context" }, ctx)).wait(ctx);
    await (await runtime.root.submit({ type: "input", content: "currently selected unrelated session" }, ctx)).wait(ctx);
    const job = await peers.submit({ id: randomUUID(), source: "server", target: "server", sourceSession: { agent: "pi", sessionId: `pi-${source}` }, targetSession: { agent: "pi", sessionId: `pi-${runtime.root.id}` }, task: "target work" });
    await peers.run(job.id);
    const submission = await runtime.root.commit(tx => tx.submissionByRequest(source, `peer-result:${job.id}`), ctx);
    assert.equal(submission?.type, "input", "a passive write cannot wake the source model");
    await until(async () => (await runtime.root.commit(tx => tx.submissionByRequest(source, `peer-result:${job.id}`), ctx))?.status === "done");
    const continuation = turns.at(-1)!;
    assert.match(continuation, /source original context/); assert.match(continuation, new RegExp(job.id));
    assert.match(continuation, /server/); assert.match(continuation, new RegExp(job.targetSession!.sessionId)); assert.match(continuation, /done/);
    assert.doesNotMatch(continuation, /currently selected unrelated session/);
    assert.equal(turns.length, 4); assert.equal((await peers.list()).length, 1, "completion receipt creates no new peer job");
    await peers.close(); await runtime.harness.close(ctx);
    peers = createPeerService({ nodeId: "server", configured: () => true });
    runtime = await openRuntime({ ...options, extensions: [peers.extension] }, ctx); peers.bind(runtime, ctx);
    await peers.run(job.id); await peers.complete(job.id, { status: "done", result: "continued" });
    assert.equal(turns.length, 4); assert.equal((await peers.list()).length, 1);
  } finally { await peers.close(); await runtime.harness.close(ctx); await rm(dataDir, { recursive: true, force: true }); }
});

test("unconfigured source retains its completed job across restart; failed acknowledgement retries admission without re-execution", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "dee-peer-pending-"));
  let configured = false, turns = 0;
  const catalog = await createModelCatalog({ api: "faux", apiKey: "", baseUrl: "", model: "", contextWindow: 128000, maxTokens: 8192 }, () => { turns++; return fauxAssistantMessage("continued"); });
  const options = { dataDir, ...catalog, onReport: () => {} };
  let peers = createPeerService({ nodeId: "server", configured: () => configured });
  let runtime = await openRuntime({ ...options, extensions: [peers.extension] }, ctx); peers.bind(runtime, ctx);
  try {
    const job = await peers.submit({ id: randomUUID(), source: "server", target: "desktop-" + randomUUID(), sourceSession: { agent: "pi", sessionId: `pi-${runtime.root.id}` }, targetSession: { agent: "codex", sessionId: randomUUID() }, task: "remote work" });
    await peers.complete(job.id, { status: "done", result: "remote result" });
    assert.equal((await peers.get(job.id))!.resultDelivered, undefined);
    assert.match((await peers.get(job.id))!.deliveryError!, /等待来源/);
    assert.equal(await runtime.root.commit(tx => tx.submissionByRequest(runtime.root.id, `peer-result:${job.id}`), ctx), undefined);
    await peers.close(); await runtime.harness.close(ctx);
    configured = true;
    peers = createPeerService({ nodeId: "server", configured: () => configured });
    runtime = await openRuntime({ ...options, extensions: [peers.extension] }, ctx); peers.bind(runtime, ctx);
    await peers.run(job.id);
    await until(async () => (await runtime.root.commit(tx => tx.submissionByRequest(runtime.root.id, `peer-result:${job.id}`), ctx))?.status === "done");
    assert.equal(turns, 1); assert.equal((await peers.get(job.id))!.resultDelivered, true); assert.equal((await peers.get(job.id))!.deliveryError, undefined);
    // Simulate a crash after native admission but before the queue acknowledgement commits.
    await runtime.root.commit(async tx => { const item = (await tx.doc(PeerJobs)).items[0]!; delete item.resultDelivered; }, ctx);
    await peers.close(); await runtime.harness.close(ctx);
    peers = createPeerService({ nodeId: "server", configured: () => true });
    runtime = await openRuntime({ ...options, extensions: [peers.extension] }, ctx); peers.bind(runtime, ctx);
    await peers.run(job.id);
    assert.equal(turns, 1); assert.equal((await peers.get(job.id))!.resultDelivered, true);
  } finally { await peers.close(); await runtime.harness.close(ctx); await rm(dataDir, { recursive: true, force: true }); }
});

test("busy source receives a follow-up without steering; legacy passive receipt upgrades once", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "dee-peer-followup-"));
  let release!: () => void, enter!: () => void, calls = 0;
  const gate = new Promise<void>(resolve => { release = resolve; }), entered = new Promise<void>(resolve => { enter = resolve; });
  const seen: string[] = [];
  const catalog = await createModelCatalog({ api: "faux", apiKey: "", baseUrl: "", model: "", contextWindow: 128000, maxTokens: 8192 }, async transcript => { seen.push(JSON.stringify(transcript.messages)); if (++calls === 1) { enter(); await gate; } return fauxAssistantMessage("continued"); });
  const peers = createPeerService({ nodeId: "server", configured: () => true });
  const runtime = await openRuntime({ dataDir, ...catalog, extensions: [peers.extension], onReport: () => {} }, ctx); peers.bind(runtime, ctx);
  try {
    const initial = await runtime.root.submit({ type: "input", content: "busy original turn" }, ctx); await entered;
    const job = await peers.submit({ id: randomUUID(), source: "server", target: "desktop-" + randomUUID(), sourceSession: { agent: "pi", sessionId: `pi-${runtime.root.id}` }, task: "remote work" });
    await peers.complete(job.id, { status: "failed", result: "remote failed" });
    assert.equal((await runtime.root.commit(tx => tx.submissionByRequest(runtime.root.id, `peer-result:${job.id}`), ctx))?.status, "queued");
    assert.equal(calls, 1); assert.doesNotMatch(seen[0]!, /remote failed/);
    release(); await initial.wait(ctx);
    await until(async () => (await runtime.root.commit(tx => tx.submissionByRequest(runtime.root.id, `peer-result:${job.id}`), ctx))?.status === "done");
    assert.equal(calls, 2); assert.match(seen[1]!, /remote failed/);
    const legacy = await peers.submit({ ...job, id: randomUUID() });
    await runtime.root.submit({ type: "write", requestId: `peer-result:${legacy.id}`, entry: { kind: "app.peer-result", data: { text: "legacy display" } } }, ctx);
    await peers.complete(legacy.id, { status: "done", result: "legacy completion" });
    await until(async () => (await runtime.root.commit(tx => tx.submissionByRequest(runtime.root.id, `peer-result:${legacy.id}:continuation`), ctx))?.status === "done");
    await peers.run(legacy.id); assert.equal(calls, 3);
  } finally { release(); await peers.close(); await runtime.harness.close(ctx); await rm(dataDir, { recursive: true, force: true }); }
});

test("target completion survives failed source delivery and restart without executing the target again", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "dee-peer-return-recovery-"));
  let targetTurns = 0, admissions = 0;
  const catalog = await createModelCatalog({ api: "faux", apiKey: "", baseUrl: "", model: "", contextWindow: 128000, maxTokens: 8192 }, () => { targetTurns++; return fauxAssistantMessage("target result"); });
  const nodeId = "desktop-" + randomUUID();
  const peerOptions = { nodeId, configured: () => true, deliverResult: async () => { if (++admissions === 1) throw new Error("source unavailable"); return true; } };
  const options = { dataDir, ...catalog, onReport: () => {} };
  let peers = createPeerService(peerOptions);
  let runtime = await openRuntime({ ...options, extensions: [peers.extension] }, ctx); peers.bind(runtime, ctx);
  try {
    const job = await peers.submit({ id: randomUUID(), source: nodeId, target: nodeId, sourceSession: { agent: "claude", sessionId: randomUUID() }, targetSession: { agent: "pi", sessionId: `pi-${runtime.root.id}` }, task: "target work" });
    await assert.rejects(peers.run(job.id), /source unavailable/);
    assert.equal((await peers.get(job.id))!.status, "done"); assert.equal((await peers.get(job.id))!.result, "target result");
    assert.equal((await peers.get(job.id))!.resultDelivered, undefined); assert.ok((await peers.get(job.id))!.deliveryError);
    await peers.close(); await runtime.harness.close(ctx);
    peers = createPeerService(peerOptions);
    runtime = await openRuntime({ ...options, extensions: [peers.extension] }, ctx); peers.bind(runtime, ctx);
    await peers.run(job.id); await peers.run(job.id);
    assert.equal(targetTurns, 1); assert.equal(admissions, 2); assert.equal((await peers.get(job.id))!.resultDelivered, true); assert.equal((await peers.get(job.id))!.deliveryError, undefined);
  } finally { await peers.close(); await runtime.harness.close(ctx); await rm(dataDir, { recursive: true, force: true }); }
});

test("model-initiated relay finishes its initial turn, then continues and queries the same job without deadlock or receipt recursion", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "dee-peer-model-relay-"));
  let release!: () => void, enter!: () => void, targetSession = "", jobId = "", targetTurns = 0, continued = false;
  const gate = new Promise<void>(resolve => { release = resolve; }), entered = new Promise<void>(resolve => { enter = resolve; });
  const catalog = await createModelCatalog({ api: "faux", apiKey: "", baseUrl: "", model: "", contextWindow: 128000, maxTokens: 8192 }, async transcript => {
    const text = JSON.stringify(transcript.messages), last = transcript.messages.at(-1);
    if (!text.includes("initial source context")) { targetTurns++; enter(); await gate; return fauxAssistantMessage("gated target result"); }
    if (last?.role === "user" && text.includes("协作任务 ")) return fauxAssistantMessage(fauxToolCall("peer_task_status", { id: jobId }), { stopReason: "toolUse" });
    if (last?.role === "toolResult") { if (text.includes("协作任务 ")) { continued = true; return fauxAssistantMessage("source resumed after checking its job"); } return fauxAssistantMessage("source waiting for target"); }
    return fauxAssistantMessage(fauxToolCall("send_to_peer_session", { target: "server", agent: "pi", sessionId: targetSession, task: "gated target work" }), { stopReason: "toolUse" });
  });
  const peers = createPeerService({ nodeId: "server", configured: () => true });
  const runtime = await openRuntime({ dataDir, ...catalog, extensions: [peers.extension], onReport: () => {} }, ctx); peers.bind(runtime, ctx);
  try {
    const target = await runtime.root.commit(async tx => { const child = await tx.createConversation({ ownership: { kind: "ownerless" } }); await configure(tx, child.id, { model: runtime.agentModel }); return child.id; }, ctx);
    targetSession = `pi-${target}`;
    const initial = await runtime.root.submit({ type: "input", content: "initial source context" }, ctx);
    assert.equal((await initial.wait(ctx)).status, "done"); await entered;
    const job = (await peers.list())[0]!; jobId = job.id;
    assert.equal(job.status, "running"); assert.equal(continued, false);
    release();
    await until(async () => (await runtime.root.commit(tx => tx.submissionByRequest(runtime.root.id, `peer-result:${job.id}`), ctx))?.status === "done");
    assert.equal(continued, true); assert.equal(targetTurns, 1); assert.equal((await peers.list()).length, 1);
  } finally { release(); await peers.close(); await runtime.harness.close(ctx); await rm(dataDir, { recursive: true, force: true }); }
});
