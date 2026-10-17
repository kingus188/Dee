import test from "node:test";
import assert from "node:assert/strict";
import { inboundKey, validateInbound, newAssistantReplies, WechatChannel } from "@assistant/channel-wechat";

test("微信入站验证与幂等键", () => {
  const input = { binding: "primary", from_wxid: "wxid_abc", message_id: "1234", text: "你好" };
  const a = validateInbound(input);
  assert.equal(a.message, "你好");
  assert.equal(a.requestId, validateInbound({ ...input, text: "另一条重试内容" }).requestId);
  assert.notEqual(a.requestId, validateInbound({ ...input, message_id: "1235" }).requestId);
  assert.notEqual(inboundKey("one", "same"), inboundKey("two", "same"));
  assert.throws(() => validateInbound({ ...input, message_id: "../../a" }), /message_id/);
  assert.throws(() => validateInbound({ ...input, binding: "../bad" }), /binding/);
  assert.throws(() => validateInbound({ ...input, from_wxid: "" }), /from_wxid/);
  assert.throws(() => validateInbound(null), /对象/);
  assert.equal(validateInbound({ binding: "primary", from_wxid: "u", message_id: "9" }).ignored, true);
  assert.equal(a.content, "你好");
});

// 引用回复：引用进独立的 content 片段，模型仍看得到，但用户原话里不含第三方内容。
test("被引用的消息不混进用户原话", () => {
  const q = validateInbound({ binding: "primary", from_wxid: "u", message_id: "1", text: "确认发送", quote: "草稿 1 私聊「小周」" });
  assert.deepEqual(q.content, [
    { type: "text", text: "<引用>\n草稿 1 私聊「小周」\n</引用>" },
    { type: "text", text: "确认发送" },
  ]);
  assert.equal(validateInbound({ binding: "primary", from_wxid: "u", message_id: "1", text: "你好" }).content, "你好");
});

// 被微信拒收的回复不会自动补发，必须出现在未送达清单里，否则用户不知道回复丢了。
test("未送达清单包含被拒收的回复", async () => {
  const outbox = [
    { id: "a", binding: "primary", wxid: "u", text: "已发", status: "sent", attempts: 1, nextAt: 0, createdAt: 1 },
    { id: "b", binding: "primary", wxid: "u", text: "重试中", status: "pending", attempts: 2, nextAt: 0, createdAt: 2 },
    { id: "c", binding: "primary", wxid: "u", text: "还没试过", status: "pending", attempts: 0, nextAt: 0, createdAt: 3 },
    { id: "d", binding: "primary", wxid: "u", text: "被拒收", status: "blocked", attempts: 3, nextAt: 0, createdAt: 4 },
  ];
  const channel = new WechatChannel({ harness: { snapshot: async () => ({ bindings: {}, cursors: {}, outbox }) } } as never);
  assert.deepEqual(await channel.undelivered(), [
    { text: "重试中", createdAt: 2, status: "pending" },
    { text: "被拒收", createdAt: 4, status: "blocked" },
  ]);
});

test("语音转写和附件降级不假装能读取媒体", () => {
  const v = validateInbound({ binding: "primary", from_wxid: "u", message_id: "1",
    voice_text: "帮我整理会议", media: [{ type: "image", path: "/private/a.png" }] });
  assert.match(v.message, /帮我整理会议/);
  assert.match(v.message, /尚不能查看附件内容/);
  assert.doesNotMatch(v.message, /private/);
});

test("仅发送已提交的助手纯文本回复，忽略工具调用与历史", () => {
  const entries = [
    { id: 1, kind: "pi.user", model: [{ content: "hello" }] },
    { id: 2, kind: "pi.assistant", model: [{ content: [{ type: "toolCall", name: "wait_seconds" }] }] },
    { id: 3, kind: "pi.tool-result", model: [{ content: [] }] },
    { id: 4, kind: "pi.assistant", model: [{ content: [{ type: "text", text: "完成" }] }] },
  ];
  assert.deepEqual(newAssistantReplies(entries, 3).replies, [{ id: 4, text: "完成" }]);
  assert.deepEqual(newAssistantReplies(entries, 4).replies, []);
  assert.equal(newAssistantReplies(entries, 4).cursor, 4);
  assert.deepEqual(newAssistantReplies(entries, 999).replies, []);
});
