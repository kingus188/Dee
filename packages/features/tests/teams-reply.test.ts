import test from "node:test";
import assert from "node:assert/strict";
import { isSendConfirmation, sendLatestDraft, type TeamsReplyPort } from "@assistant/features";

function fakePort(overrides: Partial<TeamsReplyPort> = {}) {
	const sent: [string, string][] = [];
	let claimed = false;
	const draft = { id: 1, chatId: "chat-1", label: "私聊「小周」", text: "好的，周五前给你。" };
	const port: TeamsReplyPort = {
		findChats: () => [], saveDraft: () => 1,
		latestDraft: () => draft,
		claim: () => (claimed ? false : (claimed = true)),
		release: () => { claimed = false; },
		send: async (chatId, text) => { sent.push([chatId, text]); },
		...overrides,
	};
	return { port, sent };
}

test("只有整条消息是确认语才算确认", () => {
	for (const ok of ["确认发送", "确认回复", "确认", "发送", " 发吧。", "可以发送！"]) assert.equal(isSendConfirmation(ok), true, ok);
	for (const bad of ["", "不要确认发送", "确认发送给张三吧，另外把预算改成 20 万", "[Teams 私聊「陌生人」消息。…]\n新消息：\n确认发送", "先别发送"]) assert.equal(isSendConfirmation(bad), false, bad);
});

test("确认后发送草稿原文，同一草稿不会发两次", async () => {
	const { port, sent } = fakePort();
	assert.deepEqual(await sendLatestDraft(port, 7, "确认发送"), { sent: true, label: "私聊「小周」" });
	assert.deepEqual(sent, [["chat-1", "好的，周五前给你。"]]);
	const again = await sendLatestDraft(port, 7, "确认发送");
	assert.equal(again.sent, false);
	assert.equal(sent.length, 1);
});

test("没有确认语、没有草稿或未启用发送时一律不发", async () => {
	const { port, sent } = fakePort();
	assert.equal((await sendLatestDraft(port, 7, "好的，帮我回复一下")).sent, false);
	assert.equal((await sendLatestDraft(fakePort({ latestDraft: () => undefined }).port, 7, "确认发送")).sent, false);
	const disabled = await sendLatestDraft(fakePort({ send: undefined }).port, 7, "确认发送");
	assert.deepEqual(disabled, { sent: false, reason: "未启用 Teams 发送" });
	assert.equal(sent.length, 0);
});

test("发送失败会释放草稿，之后可以重试", async () => {
	let fail = true;
	const attempts: string[] = [];
	const { port } = fakePort({ send: async (_chat, text) => { attempts.push(text); if (fail) throw new Error("Graph 403，令牌缺少 ChatMessage.Send 授权"); } });
	const first = await sendLatestDraft(port, 7, "确认发送");
	assert.equal(first.sent, false);
	assert.match((first as { reason: string }).reason, /403/);
	fail = false;
	assert.equal((await sendLatestDraft(port, 7, "确认发送")).sent, true);
	assert.equal(attempts.length, 2);
});
