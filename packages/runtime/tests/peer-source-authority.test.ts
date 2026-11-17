import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { createModelCatalog, createPeerService, openRuntime, sourceAuthorityMatches } from "@assistant/runtime";
import { PeerSourceGrants } from "../dist/peer-source-authority.js";
const model = { api: "faux", apiKey: "", baseUrl: "", model: "", contextWindow: 128000, maxTokens: 8192 };

async function source(t: TestContext, sourceAdmission?: import("../dist/peers.js").PeerOptions["sourceAdmission"]) {
  const directory = await mkdtemp(join(tmpdir(), "dee-source-authority-")), desktop = "desktop-" + randomUUID();
  let statusId: string | undefined;
  const catalog = await createModelCatalog(model, transcript => transcript.messages.at(-1)?.role === "user" ? fauxAssistantMessage(statusId ? fauxToolCall("peer_task_status", { id: statusId }) : fauxToolCall("delegate_to_peer", { target: desktop, task: "read approved workspace", workspace: "/approved" }), { stopReason: "toolUse" }) : fauxAssistantMessage("queued"));
  let peers = createPeerService({ nodeId: "server", configured: () => true, devices: async () => [desktop], sourceAdmission });
  let runtime = await openRuntime({ dataDir: directory, ...catalog, extensions: [peers.extension, peers.accessExtension], beforeToolExecute: peers.guardTool, beforeResume: async value => { peers.bind(value, ctx); }, onReport: () => {} }, ctx);
  t.after(async () => { await peers.close(); await runtime.harness.close(ctx); await rm(directory, { recursive: true, force: true }); });
  await (await runtime.root.submit({ type: "input", content: "Please read the approved desktop workspace." }, ctx)).wait(ctx);
  const job = (await peers.list())[0]!;
  return { get peers() { return peers; }, get runtime() { return runtime; }, desktop, job, directory,
    async readStatus(id: string) {
      statusId = id;
      await (await runtime.root.submit({ type: "input", content: "Read the completed job status." }, ctx)).wait(ctx);
      const page = await runtime.root.entries({}, 100, undefined, ctx);
      return JSON.stringify(page.items.filter(entry => entry.kind === "pi.tool-result"));
    },
    async reopen() {
      await peers.close(); await runtime.harness.close(ctx);
      peers = createPeerService({ nodeId: "server", configured: () => true, devices: async () => [desktop], sourceAdmission });
      runtime = await openRuntime({ dataDir: directory, ...catalog, extensions: [peers.extension, peers.accessExtension], beforeToolExecute: peers.guardTool, beforeResume: async value => { peers.bind(value, ctx); }, onReport: () => {} }, ctx);
    },
  };
}

test("only host-verified source tool admission creates a private bounded grant", async t => {
  const f = await source(t), authority = await f.peers.sourceAuthority(f.job.id);
  assert.ok(authority); assert.ok(sourceAuthorityMatches(f.job, authority, "read"));
  assert.equal(sourceAuthorityMatches(f.job, authority, "write"), false);
  assert.equal("sourceGrant" in f.job, false); assert.equal("inputs" in authority, false);
  for (const changed of [{ task: "different" }, { target: "desktop-" + randomUUID() }, { workspace: "/other" }, { targetSession: { agent: "pi" as const, sessionId: "pi-1" } }]) assert.equal(sourceAuthorityMatches({ ...f.job, ...changed }, authority, "read"), false);
  assert.equal(sourceAuthorityMatches(f.job, authority, "read", authority.expiresAt), false);
  const forged = await f.peers.submit({ ...f.job, id: randomUUID(), sourceGrant: { approved: true } } as typeof f.job);
  assert.equal(await f.peers.sourceAuthority(forged.id), undefined);
  await f.runtime.root.commit(async tx => { (await tx.doc(PeerSourceGrants)).items.find(item => item.jobId === f.job.id)!.expiresAt = Date.now() - 1; }, ctx);
  assert.equal(await f.peers.sourceAuthority(f.job.id), undefined);
});

for (const revokeWhileWaiting of [false, true, "resource"] as const) test(`target rechecks source online before reading; revoke during wait=${revokeWhileWaiting}`, async t => {
  const f = await source(t);
  let reads = 0, online = false, approvals = 0, resources = 0, entered!: () => void, release!: () => void;
  const waiting = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  const catalog = await createModelCatalog(model, transcript => transcript.messages.at(-1)?.role === "user" ? fauxAssistantMessage(fauxToolCall("read", { path: "file.txt" }), { stopReason: "toolUse" }) : fauxAssistantMessage("checked"));
  const business = defineExtension({ name: "reader", tools: [defineTool({ name: "read", description: "read", parameters: Type.Object({ path: Type.String() }), replay: "safe", execute: async () => { reads++; return { output: [] }; } })] });
  const peers = createPeerService({ nodeId: f.desktop, configured: () => true, readPolicy: { revision: "v1", tools: ["read"] },
    authorized: async () => { approvals++; if (revokeWhileWaiting === true && approvals === 3) { entered(); await gate; } return true; },
    validateRead: async () => { if (revokeWhileWaiting === "resource" && ++resources === 2) { entered(); await gate; } return true; },
    verifySource: async (job, tool) => { if (!online) throw new Error("source offline"); return sourceAuthorityMatches(job, await f.peers.sourceAuthority(job.id), tool); },
  });
  const runtime = await openRuntime({ dataDir: join(f.directory, "target"), ...catalog, extensions: [business, peers.extension, peers.accessExtension], beforeToolExecute: peers.guardTool, beforeResume: async value => { peers.bind(value, ctx); }, onReport: () => {} }, ctx);
  t.after(async () => { release(); await peers.close(); await runtime.harness.close(ctx); });
  await peers.submit(f.job);
  await assert.rejects(peers.run(f.job.id), /offline/); assert.equal(reads, 0); assert.equal((await peers.get(f.job.id))!.status, "queued");
  online = true;
  const running = peers.run(f.job.id);
  if (revokeWhileWaiting) { await waiting; await f.peers.requestCancel(f.job.id); assert.equal(await f.peers.sourceAuthority(f.job.id), undefined); release(); }
  await running; assert.equal(reads, revokeWhileWaiting ? 0 : 1);
  await peers.run(f.job.id); assert.equal(reads, revokeWhileWaiting ? 0 : 1);
  const legacy = await f.peers.submit({ ...f.job, id: randomUUID(), task: "unproved legacy task" });
  await peers.submit(legacy);
  assert.equal((await peers.run(legacy.id)).status, "failed");
  assert.equal(reads, revokeWhileWaiting ? 0 : 1, "missing source proof cannot downgrade to destination-only authority");
});

test("source ledger restart preserves the original grant, never renews expiry, and retains cancellation", async t => {
  const f = await source(t), original = await f.peers.sourceAuthority(f.job.id);
  assert.ok(original);
  await f.reopen();
  assert.deepEqual(await f.peers.sourceAuthority(f.job.id), original);
  await f.runtime.root.commit(async tx => { (await tx.doc(PeerSourceGrants)).items.find(item => item.jobId === f.job.id)!.expiresAt = Date.now() - 1; }, ctx);
  await f.reopen();
  assert.equal(await f.peers.sourceAuthority(f.job.id), undefined);
  await (await f.runtime.root.submit({ type: "input", content: "New separate desktop read request" }, ctx)).wait(ctx);
  const cancelled = (await f.peers.list()).at(-1)!; assert.notEqual(cancelled.id, f.job.id);
  await f.peers.requestCancel(cancelled.id); await f.reopen();
  assert.equal(await f.peers.sourceAuthority(cancelled.id), undefined);
  let generations = 0;
  const catalog = await createModelCatalog(model, () => { generations++; return fauxAssistantMessage("must not start"); });
  const target = createPeerService({ nodeId: f.desktop, configured: () => true, readPolicy: { revision: "v1", tools: ["read"] }, verifySource: async (job, tool) => sourceAuthorityMatches(job, await f.peers.sourceAuthority(job.id), tool) });
  const runtime = await openRuntime({ dataDir: join(f.directory, "expired-target"), ...catalog, extensions: [target.extension, target.accessExtension], beforeToolExecute: target.guardTool, beforeResume: async value => { target.bind(value, ctx); }, onReport: () => {} }, ctx);
  try {
    for (const job of [f.job, cancelled]) { await target.submit(job); assert.equal((await target.run(job.id)).status, "failed"); }
    assert.equal(generations, 0, "expired/revoked persisted authority blocks even initial model execution");
  } finally { await target.close(); await runtime.harness.close(ctx); }
});


test("source host audience admission is checked at issuance and again after restoration", async t => {
  let admitted = true, checks = 0;
  const f = await source(t, async (_tx, id) => { checks++; assert.ok(id > 0); return admitted; });
  assert.ok(await f.peers.sourceAuthority(f.job.id));
  admitted = false;
  assert.equal(await f.peers.sourceAuthority(f.job.id), undefined);
  await f.reopen();
  assert.equal(await f.peers.sourceAuthority(f.job.id), undefined);
  assert.ok(checks >= 4);
});
test("denied source audience cannot mint a grant or job", async t => {
  const f = await source(t, async () => false);
  assert.deepEqual(await f.peers.list(), []);
});

test("guarded source continuation is a body-free receipt, not a renewed execution grant", async t => {
  const f = await source(t, async () => true);
  await f.runtime.root.commit(async tx => { (await tx.doc(PeerSourceGrants)).items.find(item => item.jobId === f.job.id)!.expiresAt = Date.now() - 1; }, ctx);
  assert.equal(await f.peers.sourceAuthority(f.job.id), undefined);
  await f.peers.complete(f.job.id, { status: "done", result: "PRIVATE_COMPLETED_BODY" });
  const entries = await f.runtime.root.entries({}, 100, undefined, ctx);
  const receipts = entries.items.filter(item => item.kind === "app.peer-result");
  assert.equal(receipts.length, 1);
  assert.deepEqual(receipts[0].data, { jobId: f.job.id, status: "done" });
  assert.doesNotMatch(JSON.stringify(receipts), /PRIVATE_COMPLETED_BODY|read approved workspace|\/approved/);
  assert.match(JSON.stringify(receipts[0].model), /peer_task_status/);
  assert.equal((await f.peers.get(f.job.id))!.resultDelivered, true);
  assert.match(await f.readStatus(f.job.id), /PRIVATE_COMPLETED_BODY/, "execution TTL does not revoke a still-private source's result access");
  assert.equal(await f.peers.sourceAuthority(f.job.id), undefined, "reading a completed result cannot renew expired execution authority");
});
