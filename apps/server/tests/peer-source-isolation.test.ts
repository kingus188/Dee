import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createModelCatalog, createPeerService, openRuntime, Index, type Runtime, type PeerService } from "@assistant/runtime";
import { WechatState } from "@assistant/channel-wechat";
import type { ConversationId } from "@earendil-works/pi-durable";
import { createPrivateConversationAccess, PrivateConversationAccessError } from "../dist/conversation-access.js";
import { openEpisodeStore } from "../dist/episode-store.js";

async function fixture(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), "dee-peer-source-isolation-"));
  const store = openEpisodeStore(dir), desktop = "desktop-" + randomUUID();
  let runtime: Runtime, peers: PeerService, visible: ReturnType<typeof createPrivateConversationAccess>;
  let deviceWait: (() => Promise<void>) | undefined;
  let configured = false, transportCalls = 0, statusId = "", action: "delegate" | "status" | "sessions" | "read" | "send" | "none" = "none";
  const catalog = await createModelCatalog({ api: "faux", apiKey: "", baseUrl: "", model: "", contextWindow: 128000, maxTokens: 8192 }, transcript => {
    if (transcript.messages.at(-1)?.role === "user" && action !== "none") return fauxAssistantMessage(action === "delegate"
      ? fauxToolCall("delegate_to_peer", { target: desktop, task: "Read the explicitly approved synthetic file.", workspace: "/synthetic-approved" })
      : action === "send" ? fauxToolCall("send_to_peer_session", { target: "server", agent: "pi", sessionId: statusId, task: "MUST_NOT_EXECUTE" })
      : action === "sessions" ? fauxToolCall("peer_sessions", {})
      : action === "read" ? fauxToolCall("read_peer_session", { node: "server", agent: "pi", sessionId: statusId })
      : fauxToolCall("peer_task_status", { id: statusId }), { stopReason: "toolUse" });
    return fauxAssistantMessage("finished");
  });
  async function open() {
    peers = createPeerService({ nodeId: "server", configured: () => configured, devices: async () => { await deviceWait?.(); return [desktop]; },
      sourceAdmission: async (tx, id) => { try { await visible(id, tx); return true; } catch (error) { if (error instanceof PrivateConversationAccessError) return false; throw error; } },
      remote: async job => { transportCalls++; return { ...job, status: "running" }; },
      pollRemote: async id => { transportCalls++; return (await peers.get(id))!; },
    });
    runtime = await openRuntime({ dataDir: dir, ...catalog, extensions: [peers.extension, peers.accessExtension], beforeToolExecute: peers.guardTool,
      beforeResume: async value => { visible = createPrivateConversationAccess(value, ctx, store); peers.bind(value, ctx); }, onReport: () => {} }, ctx);
  }
  await open();
  t.after(async () => { await peers.close(); await runtime.harness.close(ctx); store.close(); await rm(dir, { recursive: true, force: true }); });
  async function conversation() {
    const owner = await runtime.harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model: catalog.agentModel } }, ctx);
    await runtime.root.commit(async tx => { (await tx.doc(Index)).items.push({ id: owner.id, title: "synthetic private", createdAt: new Date().toISOString() }); }, ctx);
    return owner.id;
  }
  async function invoke(id: ConversationId, operation: typeof action, jobId = "") {
    action = operation; statusId = jobId;
    const owner = (await runtime.harness.conversation(id, ctx))!;
    const submitted = await owner.submit({ type: "input", content: operation === "delegate" ? "Read the approved desktop file." : "Check this task status." }, ctx);
    await submitted.wait(ctx); action = "none";
    const page = await owner.entries({}, 100, undefined, ctx);
    return JSON.stringify(page.items.filter(entry => entry.kind === "pi.tool-result"));
  }
  return { get runtime() { return runtime; }, get peers() { return peers; }, store, conversation, invoke,
    pauseDevices: () => {
      let entered!: () => void, release!: () => void;
      const waiting = new Promise<void>(resolve => { entered = resolve; });
      const resume = new Promise<void>(resolve => { release = resolve; });
      deviceWait = async () => { entered(); await resume; };
      return { waiting, release: () => { deviceWait = undefined; release(); } };
    },
    calls: () => transportCalls, configure: () => { configured = true; },
    receipt: (id: ConversationId, job: string) => runtime.root.commit(tx => tx.submissionByRequest(id, `peer-result:${job}`), ctx),
    reopen: async () => { await peers.close(); await runtime.harness.close(ctx); await open(); },
  };
}

test("real SDK status lookup is bound to source session; guessed UUID cannot expose result or recover delivery", async t => {
  const f = await fixture(t), original = await f.conversation(), stranger = await f.conversation();
  await f.invoke(original, "delegate");
  const job = (await f.peers.list())[0]!;
  assert.ok(await f.peers.sourceAuthority(job.id));
  const before = f.calls();
  const foreignRunning = await f.invoke(stranger, "status", job.id);
  assert.equal(f.calls(), before, "foreign status cannot poll remote execution");
  assert.doesNotMatch(foreignRunning, /synthetic-approved|Read the explicitly approved synthetic file/);
  await f.peers.complete(job.id, { status: "done", result: "PRIVATE_RESULT_ONLY_ORIGINAL" });
  assert.equal(await f.receipt(original, job.id), undefined);
  assert.equal(await f.peers.sourceAuthority(job.id), undefined, "terminal job no longer grants execution authority");
  f.configure();
  const foreignDone = await f.invoke(stranger, "status", job.id);
  assert.doesNotMatch(foreignDone, /PRIVATE_RESULT_ONLY_ORIGINAL/);
  assert.equal(await f.receipt(original, job.id), undefined, "foreign status cannot cause source continuation");
  const own = await f.invoke(original, "status", job.id);
  assert.match(own, /PRIVATE_RESULT_ONLY_ORIGINAL/);
  assert.ok(await f.receipt(original, job.id), "legal source retains normal delivery");
  const source = (await f.runtime.harness.conversation(original, ctx))!;
  const entries = await source.entries({}, 100, undefined, ctx);
  const notices = entries.items.filter(entry => entry.kind === "app.peer-result");
  assert.equal(notices.length, 1);
  assert.deepEqual(notices[0]!.data, { jobId: job.id, status: "done" });
  assert.match(JSON.stringify(notices[0]!.model), /peer_task_status/);
  assert.doesNotMatch(JSON.stringify(notices), /PRIVATE_RESULT_ONLY_ORIGINAL|Read the explicitly approved synthetic file|synthetic-approved/);

});

for (const change of ["archive", "wechat-binding", "revoke"] as const) test(`source ${change} blocks admission, authority and completion after reopen`, async t => {
  const f = await fixture(t), original = await f.conversation();
  await f.invoke(original, "delegate");
  const job = (await f.peers.list())[0]!;
  assert.ok(await f.peers.sourceAuthority(job.id));
  if (change === "revoke") f.store.revokeSource(`conv:${original}`);
  else await f.runtime.root.commit(async tx => {
    if (change === "archive") (await tx.doc(Index)).items.find(item => item.id === original)!.archivedAt = new Date().toISOString();
    else (await tx.doc(WechatState)).bindings.synthetic = { key: "synthetic", binding: "synthetic", wxid: "synthetic", conversationId: original };
  }, ctx);
  assert.equal(await f.peers.sourceAuthority(job.id), undefined);
  const before = f.calls(), count = (await f.peers.list()).length;
  await f.invoke(original, "delegate");
  assert.equal((await f.peers.list()).length, count); assert.equal(f.calls(), before);
  f.configure();
  await assert.rejects(f.peers.complete(job.id, { status: "done", result: "BLOCKED_PRIVATE_RESULT" }), /来源|准入|访问/);
  assert.equal(await f.receipt(original, job.id), undefined);
  await f.reopen();
  await assert.rejects(f.peers.run(job.id), /来源|准入|访问/);
  const output = await f.invoke(original, "status", job.id);
  assert.doesNotMatch(output, /BLOCKED_PRIVATE_RESULT/);
  assert.equal(await f.receipt(original, job.id), undefined);
  assert.notEqual((await f.peers.get(job.id))!.resultDelivered, true);
});

test("real SDK peer session readers reject external callers and internal targets", async t => {
  const f = await fixture(t), privateSource = await f.conversation(), external = await f.conversation();
  const source = (await f.runtime.harness.conversation(privateSource, ctx))!;
  await (await source.submit({ type: "input", content: "PRIVATE_SESSION_BODY" }, ctx)).wait(ctx);
  await f.runtime.root.commit(async tx => {
    (await tx.doc(WechatState)).bindings.external = { key: "external", binding: "external", wxid: "external", conversationId: external };
  }, ctx);
  const before = f.calls();
  const directory = await f.invoke(external, "sessions");
  assert.match(directory, /当前来源会话不能读取协作会话/);
  assert.doesNotMatch(directory, /synthetic private|PRIVATE_SESSION_BODY/);
  const denied = await f.invoke(external, "read", `pi-${privateSource}`);
  assert.match(denied, /当前来源会话不能读取协作会话/);
  assert.doesNotMatch(denied, /PRIVATE_SESSION_BODY/);
  const internal = await f.invoke(privateSource, "read", `pi-${f.runtime.root.id}`);
  assert.match(internal, /目标会话不属于可读取的私人会话/);
  assert.equal(f.calls(), before, "rejected reads never access remote transport");
});


test("denied addressed sends create no job and cannot start the destination", async t => {
  const f = await fixture(t), source = await f.conversation(), target = await f.conversation();
  await f.runtime.root.commit(async tx => { (await tx.doc(WechatState)).bindings.external = { key: "external", binding: "external", wxid: "external", conversationId: source }; }, ctx);
  f.configure();
  const before = (await f.peers.list()).length;
  const result = await f.invoke(source, "send", `pi-${target}`);
  assert.match(result, /当前来源会话不能发起/);
  assert.equal((await f.peers.list()).length, before);
  const destination = (await f.runtime.harness.conversation(target, ctx))!;
  assert.equal((await destination.entries({}, 100, undefined, ctx)).items.length, 0);
  assert.equal(f.calls(), 0);
  await assert.rejects(f.peers.submit({ id: randomUUID(), source: "server", target: "server", sourceSession: { agent: "pi", sessionId: `pi-${source}` }, targetSession: { agent: "pi", sessionId: `pi-${target}` }, task: "MUST_NOT_EXECUTE" }), /当前来源会话不能发起/);
  assert.equal((await f.peers.list()).length, before, "direct local submission is fenced in admission transaction too");
});

test("real SDK status withholds completed body when source is revoked during device lookup", { timeout: 10000 }, async t => {
  const f = await fixture(t), original = await f.conversation();
  await f.invoke(original, "delegate");
  const job = (await f.peers.list())[0]!;
  await f.peers.complete(job.id, { status: "done", result: "REVOKED_DURING_DEVICES_SECRET" });
  const gate = f.pauseDevices();
  t.after(gate.release);
  const pending = f.invoke(original, "status", job.id);
  await gate.waiting;
  f.store.revokeSource(`conv:${original}`);
  gate.release();
  const output = await pending;
  assert.match(output, /来源会话准入已失效/);
  assert.doesNotMatch(output, /REVOKED_DURING_DEVICES_SECRET/);
  assert.equal(await f.receipt(original, job.id), undefined);
  assert.notEqual((await f.peers.get(job.id))!.resultDelivered, true);
});
