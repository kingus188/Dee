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
import { createModelCatalog, createPeerService, openRuntime } from "@assistant/runtime";

const desktop = "desktop-" + randomUUID();
test("peer protocol persists admission, rejects conflicting payloads, and resumes one conversation/submission", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "pi-peer-"));
  const catalog = await createModelCatalog({ api: "faux", apiKey: "", baseUrl: "", model: "", contextWindow: 128000, maxTokens: 8192 }, transcript => transcript.messages.at(-1)?.role === "toolResult" ? fauxAssistantMessage("已执行服务器业务") : fauxAssistantMessage(fauxToolCall("existing_business", {}), { stopReason: "toolUse" }));
  let businessCalls = 0;
  const business = defineExtension({ name: "business", tools: [defineTool({ name: "existing_business", description: "服务器已有业务工具", parameters: Type.Object({}), replay: "safe", execute: async () => { businessCalls++; return { output: [{ type: "text", text: "业务结果" }] }; } })] });
  const options = { dataDir, ...catalog, onReport: (error: unknown) => { throw error; }, resume: false };
  let peers = createPeerService({ nodeId: "server", configured: () => true });
  let runtime = await openRuntime({ ...options, extensions: [peers.extension, business] }, ctx);
  peers.bind(runtime, ctx);
  try {
    const input = { id: randomUUID(), source: desktop, target: "server", task: "查询服务器业务" };
    const queued = await peers.submit(input);
    assert.equal(queued.status, "queued");
    assert.equal(queued.conversationId, undefined);
    assert.deepEqual(await peers.submit(input), queued);
    await assert.rejects(peers.submit({ ...input, task: "不同任务" }), /冲突/);
    await peers.close(); await runtime.harness.close(ctx);
    peers = createPeerService({ nodeId: "server", configured: () => true });
    runtime = await openRuntime({ ...options, extensions: [peers.extension, business] }, ctx); peers.bind(runtime, ctx);
    const [done, duplicate] = await Promise.all([peers.run(input.id), peers.run(input.id)]);
    assert.equal(done.status, "done"); assert.equal(done.result, "已执行服务器业务");
    assert.deepEqual(done, duplicate);
    const child = await runtime.harness.conversation(done.conversationId! as typeof runtime.root.id, ctx);
    assert.ok(child);
    assert.ok(!(await child.agent(ctx)).tools.some(tool => tool.name === "delegate_to_peer"));
    const submissions = await runtime.root.commit(tx => tx.submissionByRequest(child.id, `peer:${input.id}`), ctx);
    assert.ok(submissions);
    assert.deepEqual(await peers.run(input.id), done);
    assert.deepEqual(await peers.complete(input.id, { status: "done", result: done.result! }), done);
    await assert.rejects(peers.complete(input.id, { status: "failed", result: "改写结果" }), /冲突/);
    await peers.close(); await runtime.harness.close(ctx);
    peers = createPeerService({ nodeId: "server", configured: () => true });
    runtime = await openRuntime({ ...options, extensions: [peers.extension, business] }, ctx); peers.bind(runtime, ctx);
    assert.deepEqual(await peers.run(input.id), done);
    assert.equal((await runtime.root.commit(tx => tx.submissionByRequest(child.id, `peer:${input.id}`), ctx))?.id, submissions.id);
    assert.equal(businessCalls, 1);
    assert.ok((await (await runtime.harness.conversation(child.id, ctx))!.agent(ctx)).tools.some(tool => tool.name === "existing_business"));
    const outbound = await peers.submit({ id: randomUUID(), source: "server", target: desktop, task: "读取本机文件（等待本机确认）" });
    assert.deepEqual(await peers.run(outbound.id), outbound);
    assert.equal((await peers.get(outbound.id))?.conversationId, undefined);
    await peers.close(); await runtime.harness.close(ctx);
    peers = createPeerService({ nodeId: "server", configured: () => true });
    runtime = await openRuntime({ ...options, extensions: [peers.extension, business] }, ctx); peers.bind(runtime, ctx);
    assert.deepEqual(await peers.get(outbound.id), outbound);
    await assert.rejects(peers.submit({ id: randomUUID(), source: desktop, target: "desktop-" + randomUUID(), task: "旁路" }), /本节点/);
    await assert.rejects(peers.submit({ ...input, id: "bad" }), /ID/);
    await peers.complete(outbound.id, { status: "failed", result: "本机用户拒绝" });
    await peers.close(); await runtime.harness.close(ctx);
    peers = createPeerService({ nodeId: "server", configured: () => true });
    runtime = await openRuntime({ ...options, extensions: [peers.extension, business] }, ctx); peers.bind(runtime, ctx);
    assert.equal((await peers.get(outbound.id))?.result, "本机用户拒绝");
  } finally { await peers.close(); await runtime.harness.close(ctx); await rm(dataDir, { recursive: true, force: true }); }
});

test("interrupted local run reopens the same child and submission", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "pi-peer-interrupted-"));
  let entered!: () => void;
  const generating = new Promise<void>(resolve => { entered = resolve; });
  let interrupt = true;
  const catalog = await createModelCatalog({ api: "faux", apiKey: "", baseUrl: "", model: "", contextWindow: 128000, maxTokens: 8192 }, async (_transcript, options) => {
    if (interrupt) {
      entered();
      await new Promise<void>(resolve => options?.signal?.addEventListener("abort", () => resolve(), { once: true }));
      return fauxAssistantMessage("", { stopReason: "aborted" });
    }
    return fauxAssistantMessage("重开完成");
  });
  const options = { dataDir, ...catalog, resume: false, onReport: (_error: unknown) => {} };
  let peers = createPeerService({ nodeId: "server", configured: () => true });
  let runtime = await openRuntime({ ...options, extensions: [peers.extension] }, ctx); peers.bind(runtime, ctx);
  try {
    const job = await peers.submit({ id: randomUUID(), source: desktop, target: "server", task: "恢复任务" });
    const pending = peers.run(job.id); void pending.catch(() => {});
    await generating;
    const before = (await peers.get(job.id))!;
    assert.equal(before.status, "running");
    const admitted = await runtime.root.commit(tx => tx.submissionByRequest(before.conversationId! as typeof runtime.root.id, `peer:${job.id}`), ctx);
    await peers.close(); await runtime.harness.close(ctx);
    interrupt = false;
    peers = createPeerService({ nodeId: "server", configured: () => true });
    runtime = await openRuntime({ ...options, extensions: [peers.extension] }, ctx); peers.bind(runtime, ctx);
    const done = await peers.run(job.id);
    assert.equal(done.conversationId, before.conversationId);
    assert.equal(done.status, "done");
    assert.equal(done.result, "重开完成");
    assert.equal((await runtime.root.commit(tx => tx.submissionByRequest(before.conversationId! as typeof runtime.root.id, `peer:${job.id}`), ctx))?.id, admitted?.id);
  } finally { await peers.close(); await runtime.harness.close(ctx); await rm(dataDir, { recursive: true, force: true }); }
});

test("remote transport retries use the same job and reject a mismatched response", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "pi-peer-remote-"));
  const catalog = await createModelCatalog({ api: "faux", apiKey: "", baseUrl: "", model: "", contextWindow: 128000, maxTokens: 8192 }, fauxAssistantMessage("unused"));
  let attempts = 0;
  const peers = createPeerService({ nodeId: desktop, configured: () => true, remote: async job => {
    attempts++;
    if (attempts === 1) throw new Error("断线");
    if (attempts === 2) return { ...job, task: "篡改" };
    return { ...job, status: "done", result: "远端已完成" };
  } });
  const runtime = await openRuntime({ dataDir, ...catalog, extensions: [peers.extension], onReport: error => { throw error; } }, ctx);
  peers.bind(runtime, ctx);
  try {
    const job = await peers.submit({ id: randomUUID(), source: desktop, target: "server", task: "远端任务" });
    await assert.rejects(peers.run(job.id), /断线/);
    await assert.rejects(peers.run(job.id), /冲突/);
    assert.equal((await peers.run(job.id)).result, "远端已完成");
    assert.equal((await peers.run(job.id)).status, "done");
    assert.equal(attempts, 3);
    assert.equal((await peers.list()).length, 1);
  } finally { await peers.close(); await runtime.harness.close(ctx); await rm(dataDir, { recursive: true, force: true }); }
});
