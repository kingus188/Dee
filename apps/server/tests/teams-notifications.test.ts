import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { createModelCatalog, openRuntime, Index } from "@assistant/runtime";
import { WechatChannel, WechatState } from "@assistant/channel-wechat";
import { openTeamsStore } from "../dist/teams-store.js";
import { reviewTeamsNotification } from "../dist/teams-notifications.js";

const at = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
const incoming = (id: string, chatId = id) => ({ id, chatId, chatType: "oneOnOne", senderId: "user", senderName: "测试同事", direction: "in" as const, text: "需要查看的原文", createdAt: at(10), important: true });

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "pi-reminder-"));
  const store = openTeamsStore(dir);
  const { models, agentModel } = await createModelCatalog({ api: "faux", apiKey: "", baseUrl: "", model: "", contextWindow: 128000, maxTokens: 8192 }, fauxAssistantMessage("原来的摘要和建议"));
  const options = { dataDir: dir, models, agentModel, extensions: [], onReport: (error: unknown) => { throw error; } };
  let runtime = await openRuntime(options, context);
  let fails = false, syncFails = false, calls = 0, reviews = 0;
  const sent: string[] = [];
  const sender = { refresh: async () => { if (syncFails) throw Error("offline"); return { ok: true, lastSuccessAt: new Date().toISOString() }; } };
  const makeChannel = () => new WechatChannel({ ...runtime, context, indexDoc: Index, sendURL: "http://localhost:1/v1/send", sendToken: "test", intervalMs: 999999,
    fetchImpl: (async (_url, init) => { calls++; if (fails) throw Error("offline"); sent.push(JSON.parse(init!.body as string).text); return new Response("{}", { status: 200 }); }) as typeof fetch,
    reviewNotification: async source => { reviews++; return reviewTeamsNotification(store, sender, source); },
  });
  let channel = makeChannel(); channel.stop();
  async function settle() {
    await runtime.harness.waitForIdle(context);
    const state = await runtime.harness.snapshot(WechatState, context);
    for (const binding of Object.values(state!.bindings)) {
      const conversation = (await runtime.harness.conversation(binding.conversationId, context))!;
      const view = await conversation.viewState(context);
      try { await channel.scan(binding, view.value); } finally { view.dispose(); }
    }
  }
  async function deliver() {
    const internal = channel as unknown as { stopped: boolean; tick(): Promise<void> };
    internal.stopped = false;
    try { await internal.tick(); } finally { channel.stop(); }
  }
  const state = () => runtime.harness.snapshot(WechatState, context);
  const reply = (id: string) => store.record({ ...incoming("out:" + id, id), direction: "out", senderId: "me", createdAt: at(1), important: false });
  return {
    store, sender, sent, state, settle, deliver, reply,
    channel: () => channel,
    calls: () => calls, reviews: () => reviews,
    failSend: (value: boolean) => { fails = value; }, failSync: (value: boolean) => { syncFails = value; },
    block: () => runtime.root.commit(async tx => { for (const item of (await tx.doc(WechatState)).outbox) item.status = "blocked"; }, context),
    due: () => runtime.root.commit(async tx => { for (const item of (await tx.doc(WechatState)).outbox) item.nextAt = 0; }, context),
    restart: async () => { channel.stop(); await runtime.harness.close(context); runtime = await openRuntime(options, context); channel = makeChannel(); channel.stop(); },
    close: async () => { channel.stop(); await runtime.harness.close(context); store.close(); await rm(dir, { recursive: true, force: true }); },
  };
}

test("生成期间已回复：submission 精确关联来源，首次投递撤销而不发送", async () => {
  const f = await fixture();
  try {
    f.store.record(incoming("a"));
    await f.channel().notify("primary", "wxid_test", "[Teams 新消息] 测试", { kind: "teams", messageIds: ["a"] });
    f.reply("a"); await f.settle();
    assert.deepEqual((await f.state())!.outbox[0].source, { kind: "teams", messageIds: ["a"] });
    await f.deliver();
    const item = (await f.state())!.outbox[0];
    assert.equal(item.status, "cancelled"); assert.ok(item.cancelReason); assert.ok(item.cancelledAt);
    assert.equal(f.calls(), 0);
  } finally { await f.close(); }
});

test("失败重试及重启：保留来源，后来已回复不再发送；不重复生成同一提醒", async () => {
  const f = await fixture();
  try {
    f.store.record(incoming("a"));
    await f.channel().notify("primary", "wxid_test", "[Teams 新消息] 测试", { kind: "teams", messageIds: ["a"] });
    await f.settle(); f.failSend(true); await f.deliver();
    assert.equal((await f.state())!.outbox[0].status, "pending"); assert.equal(f.calls(), 1);
    await f.restart(); f.reply("a"); f.failSend(false); await f.due();
    await f.channel().notify("primary", "wxid_test", "[Teams 新消息] 测试", { kind: "teams", messageIds: ["a"] });
    await f.settle(); await f.deliver();
    assert.equal((await f.state())!.outbox.length, 1);
    assert.equal((await f.state())!.outbox[0].status, "cancelled"); assert.equal(f.calls(), 1); assert.equal(f.reviews(), 2);
  } finally { await f.close(); }
});

test("同步失败保留待发，混合摘要只重建有效来源；普通问答不参加自动提醒撤销", async () => {
  const f = await fixture();
  try {
    f.store.record(incoming("a")); f.store.record({ ...incoming("b"), senderName: "仍待回复同事", text: "仍然有效的请求" });
    await f.channel().notify("primary", "wxid_test", "[Teams 新消息] 两条摘要", { kind: "teams", messageIds: ["a", "b"] });
    await f.settle(); f.reply("a"); f.failSync(true); await f.deliver();
    assert.equal((await f.state())!.outbox[0].status, "pending"); assert.equal(f.calls(), 0);
    f.failSync(false); await f.due(); await f.deliver();
    assert.equal(f.sent.length, 1); assert.match(f.sent[0], /仍然有效的请求/); assert.doesNotMatch(f.sent[0], /需要查看的原文|原来的摘要和建议/);
    await f.channel().incoming({ binding: "primary", from_wxid: "wxid_test", message_id: "100", text: "未回复有哪些", source: { kind: "teams", messageIds: ["a"] } });
    await f.settle(); f.failSync(true); await f.deliver();
    assert.equal(f.sent.length, 2); assert.equal((await f.state())!.outbox[1].source, undefined);
  } finally { await f.close(); }
});

test("旧积压只按确定 requestId 迁移来源，保留来源不明的普通回复", async () => {
  const f = await fixture();
  try {
    f.store.record(incoming("legacy"));
    const digits = BigInt("0x" + createHash("sha256").update("legacy").digest("hex").slice(0, 24)).toString();
    await f.channel().incoming({ binding: "primary", from_wxid: "wxid_test", message_id: digits, text: "[Teams 新消息] 原始注入" });
    await f.settle();
    await f.channel().incoming({ binding: "primary", from_wxid: "wxid_test", message_id: "200", text: "查一下未回复" });
    await f.settle();
    assert.deepEqual(await f.channel().linkLegacyTeams(f.store.notificationIds()), { linked: 1, unknown: 1 });
    f.reply("legacy"); await f.deliver();
    const items = (await f.state())!.outbox;
    assert.equal(items[0].status, "cancelled"); assert.equal(items[1].status, "sent"); assert.equal(f.calls(), 1);
    assert.deepEqual(await f.channel().linkLegacyTeams(f.store.notificationIds()), { linked: 0, unknown: 0 });
  } finally { await f.close(); }
});


test("被微信永久拒收的提醒不会自动重发，但已回复后可以撤销；过期来源不投递", async () => {
  const f = await fixture();
  try {
    f.store.record(incoming("a"));
    await f.channel().notify("primary", "wxid_test", "[Teams 新消息] 测试", { kind: "teams", messageIds: ["a"] });
    await f.settle(); await f.block(); await f.deliver();
    assert.equal((await f.state())!.outbox[0].status, "blocked"); assert.equal(f.calls(), 0);
    f.reply("a"); await f.due(); await f.deliver();
    assert.equal((await f.state())!.outbox[0].status, "cancelled"); assert.equal(f.calls(), 0);
    f.store.record({ ...incoming("expired"), createdAt: at(25 * 60) });
    assert.equal((await reviewTeamsNotification(f.store, {}, { kind: "teams", messageIds: ["expired"] })).status, "cancel");
  } finally { await f.close(); }
});
