import assert from "node:assert/strict";
import test from "node:test";
import type { ConversationId } from "@earendil-works/pi-durable";
import type { AppContext } from "../dist/application/context.js";
import { createConversations } from "../dist/application/conversations.js";
import { initialConversationTitle, repairConversationTitles } from "../dist/conversation-titles.js";
import { Index } from "@assistant/runtime";
import { WechatState } from "@assistant/channel-wechat";
import { buildUserContent } from "@assistant/features";
import { createMessages } from "../dist/application/messages.js";
import type { Conversation } from "@earendil-works/pi-durable";

test("首条消息替换小 D 与新对话默认名，保留已命名会话和通道名称", async () => {
  const index = { items: [
    { id: 1, title: "小 D", channel: "web" },
    { id: 2, title: "新对话" },
    { id: 3, title: "项目合同讨论", channel: "web" },
    { id: 4, title: "小 D", channel: "wechat" },
    { id: 5, title: "小 D" },
    { id: 6, title: "小 D", channel: "web" },
  ] };
  const wechat = { bindings: { legacy: { conversationId: 5 }, stale: { conversationId: 6 } } };
  const conversations = createConversations({ root: { commit: async (change: (tx: unknown) => unknown) => change({ doc: async (doc: unknown) => doc === Index ? index : wechat }) } } as unknown as AppContext);
  for (const item of index.items) await conversations.updateTitle(item.id as ConversationId, "整理客户合同的交付流程");
  assert.deepEqual(index.items.map(item => item.title), ["整理客户合同的交付流程", "整理客户合同的交付流程", "项目合同讨论", "小 D", "小 D", "小 D"]);
});

test("实际消息提交后立即保存首条用户消息标题，后续对话不覆盖", async () => {
  const index = { items: [{ id: 1, title: "小 D", channel: "web" }] };
  const context = { root: { commit: async (change: (tx: unknown) => unknown) => change({ doc: async (doc: unknown) => doc === Index ? index : { bindings: {} } }) } } as unknown as AppContext;
  const messages = createMessages(context, createConversations(context));
  const inputs: unknown[] = [];
  const conversation = { id: 1, submit: async (input: unknown) => { inputs.push(input); return { id: 100 }; } } as unknown as Conversation;
  const text = "帮我整理一下客户合同与项目交付的流程";
  assert.deepEqual(await messages.submit(conversation, { text, requestId: "first" }), { submissionId: 100 });
  assert.equal(index.items[0].title, text);
  await messages.submit(conversation, { text: "再讨论另一个问题", requestId: "second" });
  assert.equal(index.items[0].title, text);
  assert.equal(inputs.length, 2);
});

test("旧默认标题按最早有效用户消息补齐，跳过通道、分叉、归档、空会话并保护并发改名", async () => {
  const index = { items: [
    { id: 1, title: "小 D", channel: "web" }, { id: 2, title: "新对话" },
    { id: 3, title: "自己设置的标题" }, { id: 4, title: "小 D", channel: "wechat" },
    { id: 5, title: "新对话" }, { id: 6, title: "小 D", channel: "web" },
    { id: 7, title: "新对话", archivedAt: "2026-01-01" }, { id: 8, title: "小 D", forkOf: 1 },
    { id: 9, title: "小 D" }, { id: 10, title: "新对话" },
  ] };
  const wechat = { bindings: { private: { conversationId: 5, wxid: "private-recipient" } } };
  const user = (content: unknown) => ({ kind: "pi.user", model: [{ role: "user", content }] });
  const content = buildUserContent("", [{ kind: "text", name: "合同说明.md", mimeType: "text/plain", size: 6, text: "第三方附件正文不作为标题" }]);
  const histories = new Map<number, object[]>([
    [1, [user([{ type: "text", text: "<引用>\n第三方的标题\n</引用>" }]), user("整理项目交付与合同")]],
    [2, [user(content)]], [6, []], [10, [user("准备更新的标题")]],
  ]);
  const before = structuredClone({ histories, wechat });
  const reads: number[] = []; let commits = 0;
  const context = {
    harness: {
      snapshot: async (doc: unknown) => doc === Index ? index : doc === WechatState ? wechat : undefined,
      conversation: async (id: number) => {
        reads.push(id);
        if (!histories.has(id)) return;
        return { entries: async (query: { order: string }, limit: number, cursor?: object) => {
          assert.equal(query.order, "ascending"); assert.equal(limit, 50);
          return id === 1 && !cursor ? { items: [{ kind: "pi.assistant" }], next: { page: 2 } } : { items: histories.get(id) };
        } };
      },
    },
    root: { commit: async (change: (tx: unknown) => unknown) => { commits++; index.items[9].title = "用户刚刚改的标题"; return change({ doc: async () => index }); } },
  } as unknown as AppContext;
  assert.equal(await repairConversationTitles(context, context.ctx), 2);
  assert.equal(index.items[0].title, "整理项目交付与合同");
  assert.equal(index.items[1].title, "[附件] 合同说明.md");
  assert.deepEqual(index.items.slice(2).map(item => item.title), ["自己设置的标题", "小 D", "新对话", "小 D", "新对话", "小 D", "小 D", "用户刚刚改的标题"]);
  assert.deepEqual(reads, [1, 2, 6, 9, 10]);
  assert.deepEqual({ histories, wechat }, before);
  assert.equal(await repairConversationTitles(context, context.ctx), 0);
  assert.equal(commits, 1, "幂等重跑不能创建额外写入");
});

test("标题按用户正文提取，排除正式引用与附件正文，Unicode 不截断", () => {
  assert.equal(initialConversationTitle([{ type: "text", text: "<引用>\n第三方原文\n</引用>" }, { type: "text", text: "  请核对项目范围  " }]), "请核对项目范围");
  assert.equal(initialConversationTitle("😀".repeat(21)), "😀".repeat(20));
  assert.equal(initialConversationTitle(""), "");
});
