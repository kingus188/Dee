import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { configure } from "@earendil-works/pi-durable";
import { Index, createModelCatalog, createPeerService, openRuntime } from "@assistant/runtime";

test("addressed peer delivery resumes the requested context and returns once to its source", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "dee-peer-sessions-"));
  const seen: string[] = [];
  const catalog = await createModelCatalog({ api: "faux", apiKey: "", baseUrl: "", model: "", contextWindow: 128000, maxTokens: 8192 }, transcript => {
    seen.push(JSON.stringify(transcript.messages));
    return fauxAssistantMessage("target answer");
  });
  const peers = createPeerService({ nodeId: "server", configured: () => true });
  const runtime = await openRuntime({ dataDir, ...catalog, extensions: [peers.extension], onReport: () => {} }, ctx);
  peers.bind(runtime, ctx);
  try {
    const target = await runtime.root.commit(async tx => {
      const child = await tx.createConversation({ ownership: { kind: "ownerless" } });
      await configure(tx, child.id, { model: runtime.agentModel });
      return child.id;
    }, ctx);
    const conversation = (await runtime.harness.conversation(target, ctx))!;
    await (await conversation.submit({ type: "input", content: "target secret context" }, ctx)).wait(ctx);
    const input = { id: randomUUID(), source: "server", target: "server", task: "continue target",
      sourceSession: { agent: "pi" as const, sessionId: `pi-${runtime.root.id}` },
      targetSession: { agent: "pi" as const, sessionId: `pi-${target}` } };
    await peers.submit(input);
    const [done, duplicate] = await Promise.all([peers.run(input.id), peers.run(input.id)]);
    assert.equal(done.status, "done"); assert.equal(done.conversationId, target); assert.deepEqual(done, duplicate);
    assert.ok(seen.some(turn => turn.includes("continue target") && turn.includes("target secret context")));
    assert.equal((await runtime.root.context(ctx)).entries.filter(entry => entry.kind === "app.peer-result").length, 1);
    await peers.run(input.id);
    assert.equal((await runtime.root.context(ctx)).entries.filter(entry => entry.kind === "app.peer-result").length, 1);
    await assert.rejects(peers.submit({ ...input, targetSession: input.sourceSession }), /相同|冲突/);
    assert.ok((await peers.sessions()).some(item => item.sessionId === `pi-${target}`));
    assert.ok((await peers.readSession(input.targetSession)).messages.some(message => message.text === "continue target"));
  } finally { await peers.close(); await runtime.harness.close(ctx); await rm(dataDir, { recursive: true, force: true }); }
});

test("a busy Pi target uses its durable follow-up inbox without steering the running context", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "dee-peer-busy-"));
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { entered = resolve; });
  let calls = 0;
  const catalog = await createModelCatalog({ api: "faux", apiKey: "", baseUrl: "", model: "", contextWindow: 128000, maxTokens: 8192 }, async () => { if (++calls === 1) { entered(); await gate; } return fauxAssistantMessage("settled"); });
  const peers = createPeerService({ nodeId: "server", configured: () => true });
  const runtime = await openRuntime({ dataDir, ...catalog, extensions: [peers.extension], onReport: () => {} }, ctx); peers.bind(runtime, ctx);
  try {
    const target = await runtime.root.commit(async tx => { const child = await tx.createConversation({ ownership: { kind: "ownerless" } }); await configure(tx, child.id, { model: runtime.agentModel }); return child.id; }, ctx);
    const conversation = (await runtime.harness.conversation(target, ctx))!;
    const first = await conversation.submit({ type: "input", content: "hold" }, ctx); await started;
    const job = await peers.submit({ id: randomUUID(), source: "server", target: "server", sourceSession: { agent: "pi", sessionId: `pi-${runtime.root.id}` }, targetSession: { agent: "pi", sessionId: `pi-${target}` }, task: "queued follow-up" });
    const pending = peers.run(job.id); void pending.catch(() => {});
    const deadline = Date.now() + 3000;
    let queued = false;
    while (Date.now() < deadline) {
      queued = (await runtime.root.commit(tx => tx.submissionByRequest(target, `peer:${job.id}`), ctx))?.status === "queued";
      if (queued) break;
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.equal(queued, true); assert.equal(calls, 1);
    assert.ok(!JSON.stringify((await conversation.context(ctx)).messages).includes("queued follow-up"));
    release(); await first.wait(ctx);
    assert.equal((await pending).status, "done");
    const sourceDeadline = Date.now() + 3000;
    while ((await runtime.root.commit(tx => tx.submissionByRequest(runtime.root.id, `peer-result:${job.id}`), ctx))?.status !== "done") {
      assert.ok(Date.now() < sourceDeadline, "source continuation must finish without another user input");
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.equal(calls, 3);
  } finally { release(); await peers.close(); await runtime.harness.close(ctx); await rm(dataDir, { recursive: true, force: true }); }
});

test("status tools never schedule a queued same-node destination from its source turn", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "dee-peer-status-")), nodeId = "desktop-" + randomUUID();
  const id = randomUUID(); let authorizedCalls = 0;
  const catalog = await createModelCatalog({ api: "faux", apiKey: "", baseUrl: "", model: "", contextWindow: 128000, maxTokens: 8192 }, transcript => transcript.messages.at(-1)?.role === "toolResult" ? fauxAssistantMessage("status observed") : fauxAssistantMessage(fauxToolCall("peer_task_status", { id }), { stopReason: "toolUse" }));
  const peers = createPeerService({ nodeId, configured: () => true, authorized: async () => { authorizedCalls++; return false; }, remote: async () => { throw new Error("unexpected transport"); } });
  const runtime = await openRuntime({ dataDir, ...catalog, extensions: [peers.extension], onReport: () => {} }, ctx); peers.bind(runtime, ctx);
  try {
    const target = await runtime.root.commit(async tx => { const child = await tx.createConversation({ ownership: { kind: "ownerless" } }); await configure(tx, child.id, { model: runtime.agentModel }); return child.id; }, ctx);
    await peers.submit({ id, source: nodeId, target: nodeId, sourceSession: { agent: "pi", sessionId: `pi-${runtime.root.id}` }, targetSession: { agent: "pi", sessionId: `pi-${target}` }, task: "await approval" });
    assert.equal((await (await runtime.root.submit({ type: "input", content: "inspect status" }, ctx)).wait(ctx)).status, "done");
    assert.equal(authorizedCalls, 0); assert.equal((await peers.get(id))!.status, "queued");
  } finally { await peers.close(); await runtime.harness.close(ctx); await rm(dataDir, { recursive: true, force: true }); }
});


test("archiving conversations cannot be addressed by a peer until explicitly restored", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "dee-peer-archiving-"));
  const catalog = await createModelCatalog({ api: "faux", apiKey: "", baseUrl: "", model: "", contextWindow: 128000, maxTokens: 8192 }, fauxAssistantMessage("ok"));
  const peers = createPeerService({ nodeId: "server", configured: () => true });
  const runtime = await openRuntime({ dataDir, ...catalog, extensions: [peers.extension], onReport: () => {} }, ctx); peers.bind(runtime, ctx);
  try {
    const target = await runtime.root.commit(async tx => {
      const child = await tx.createConversation({ ownership: { kind: "ownerless" } });
      await configure(tx, child.id, { model: runtime.agentModel });
      (await tx.doc(Index)).items.push({ id: child.id, title: "stopping", createdAt: "2026-01-01", archivingAt: "2026-01-02" });
      return child.id;
    }, ctx);
    const targetSession = { agent: "pi" as const, sessionId: `pi-${target}` };
    assert.ok(!(await peers.sessions()).some(item => item.sessionId === targetSession.sessionId));
    await assert.rejects(peers.readSession(targetSession), /不存在|不可用/);
    const job = await peers.submit({ id: randomUUID(), source: "server", target: "server", task: "must not run", targetSession, sourceSession: { agent: "pi", sessionId: `pi-${runtime.root.id}` } });
    assert.equal((await peers.run(job.id)).status, "failed");
    const targetConversation = (await runtime.harness.conversation(target, ctx))!;
    assert.equal((await targetConversation.context(ctx)).entries.length, 0);
    await runtime.root.commit(async tx => { (await tx.doc(Index)).items[0].archivingAt = null; }, ctx);
    assert.ok((await peers.sessions()).some(item => item.sessionId === targetSession.sessionId));
  } finally { await peers.close(); await runtime.harness.close(ctx); await rm(dataDir, { recursive: true, force: true }); }
});
