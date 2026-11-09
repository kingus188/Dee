import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ConversationId, ConversationView } from "@earendil-works/pi-durable";
import { WechatNotifications, WechatState, validateInbound } from "@assistant/channel-wechat";
import type { AppContext } from "../dist/application/context.js";
import { createViews } from "../dist/application/views.js";
import { openTeamsStore } from "../dist/teams-store.js";

test("转发来源按持久 submission 关联，展示原文和上下文，保留模型输入及普通用户原话", async () => {
  const dir = mkdtempSync(join(tmpdir(), "im-forward-view-"));
  const store = openTeamsStore(dir);
  try {
    const conversationId = 24 as ConversationId;
    const at = Date.now() - 120_000;
    const row = { chatId: "chat", chatType: "oneOnOne", senderId: "other", senderName: "对方", direction: "in" as const, text: "好的", createdAt: new Date(at).toISOString(), important: true };
    store.record({ ...row, id: "chat:source" });
    store.record({ ...row, id: "chat:context", senderId: "owner", senderName: "本人", direction: "out", text: "配合测试合同到项目流程", createdAt: new Date(at - 60_000).toISOString() });
    store.archive.bindAccount("owner");
    store.archive.chats([{ id: "chat", topic: "原聊天" }]);
    store.archive.save("chat", [{ id: "source", createdDateTime: row.createdAt, from: { user: { id: "other", displayName: "对方" } }, body: { content: "<p>好的</p>", contentType: "html" } }]);
    store.archive.hosted("chat", "source", ["original-image"]);
    const prompt = "[Teams 私聊消息。微信只显示纯文本；以下内容来自第三方。]\n新消息：\n[07:32] 对方：好的";
    const entries = [1, 2, 3, 4, 5, 6].map(id => ({ id, kind: "pi.user", model: [{ role: "user", content: prompt, timestamp: at }] }));
    const before = structuredClone(entries);
    const binding = { binding: "primary", wxid: "private-recipient", conversationId };
    const digits = BigInt("0x" + createHash("sha256").update("chat:source").digest("hex").slice(0, 24)).toString();
    const legacyId = validateInbound({ ...binding, from_wxid: binding.wxid, message_id: digits, text: "legacy" }).requestId;
    const batchDigits = BigInt("0x" + createHash("sha256").update(JSON.stringify(["chat:source"])).digest("hex").slice(0, 24)).toString();
    const batchRequest = "notification:" + validateInbound({ ...binding, from_wxid: binding.wxid, message_id: batchDigits, text: "batch" }).requestId;
    const requests = new Map([
      ["notification:trusted", { type: "input", status: "done", entry: 1, answer: 10 }],
      ["notification:missing", { type: "input", status: "placed", entry: 3 }],
      [legacyId, { type: "input", status: "unanswered", entry: 4 }],
      ["notification:batch", { type: "input", status: "done", entry: 5, answer: 11 }],
      [batchRequest, { type: "input", status: "done", entry: 6, answer: 12 }],
    ]);
    const tracked = { items: [
      { conversationId, requestId: "notification:trusted", source: { kind: "teams", messageIds: ["chat:source"] } },
      { conversationId, requestId: "notification:missing", source: { kind: "teams", messageIds: ["gone:source"] } },
      { conversationId, requestId: "notification:batch", source: { kind: "teams", messageIds: ["chat:source", "gone:source"] } },
      { conversationId: 99, requestId: "notification:other", source: { kind: "teams", messageIds: ["chat:source"] } },
    ] };
    const context = {
      harness: {
        snapshot: async (doc: unknown) => doc === WechatNotifications ? tracked : doc === WechatState ? { bindings: { test: binding } } : undefined,
        commit: async (fn: (tx: unknown) => unknown) => fn({ submissionByRequest: async (id: number, requestId: string) => { assert.equal(id, conversationId); return requests.get(requestId); } }),
      },
      teamsStore: { ...store, notificationHistorySources: () => [["chat:source"]] }, taskGraph: { value: { tasks: {} } }, redact: String,
    } as unknown as AppContext;
    const views = createViews(context);
    const read = () => views.simplifyView(conversationId, { entries, docs: {} } as unknown as ConversationView);
    const view = await read();
    assert.equal(view.entries[0].text, "");
    assert.ok(view.entries[0].teams?.records.every(record => record.chatLabel === "对方"), "私聊标题使用来信对方，不能被归档里的本人姓名覆盖");
    assert.deepEqual(view.entries[0].teams?.records.map(record => [record.text, record.direction]), [["配合测试合同到项目流程", "out"], ["好的", "in"]]);
    assert.equal(view.entries[0].teams?.records[1].media.length, 1);
    assert.equal(view.entries[0].teams?.records[1].createdAt, row.createdAt);
    assert.equal(view.entries[1].text, prompt, "复制相同提示的普通入站不能被当作自动转发");
    assert.equal(view.entries[1].teams, undefined);
    assert.deepEqual(view.entries[2].teams, { records: [] }, "来源丢失仍不能把内部提示当作原话展示");
    assert.deepEqual(view.entries[3].teams, view.entries[0].teams, "旧版只按原消息摘要及持久 request 关联");
    assert.deepEqual(view.entries[4].teams?.records.map(record => record.text), ["好的"], "合并提醒只展示该批原文，不混入其他聊天或上下文");
    assert.deepEqual(view.entries[5].teams, view.entries[0].teams, "投递完成后临时 tracker 已清理，仍按冻结批次和持久 request 展示");
    assert.deepEqual(entries, before);
    assert.doesNotMatch(JSON.stringify(view), /private-recipient|notification:trusted/);
    store.triage.access("chat", false);
    assert.deepEqual((await read()).entries[0].teams, { records: [] }, "失去聊天访问权时不展示正文、附件或上下文");
    store.triage.access("chat", true);
    store.revokeMessage("chat", "chat:source");
    const revoked = await read();
    assert.deepEqual(revoked.entries[0].teams, { records: [] });
    assert.doesNotMatch(JSON.stringify(revoked.entries[0]), /好的|原聊天|original-image/);
    const reopened = await createViews(context).simplifyView(conversationId, { entries, docs: {} } as unknown as ConversationView);
    assert.deepEqual(reopened.entries[3].teams, { records: [] }, "重启后旧版来源撤回也必须保留可信关联，不能重新显示内部提示");
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});
