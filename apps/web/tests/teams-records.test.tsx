import test from "node:test";
import assert from "node:assert/strict";
import { act, createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { teamsRecords, TeamsRecords } from "../dist/chat/TeamsRecords.js";
import { ChatThread } from "../dist/chat/ChatThread.js";
import type { ConversationView } from "@assistant/contracts";
import type { ToolActivity } from "../dist/chat/activities.js";
import { mount } from "./dom.js";

const image = { id: "a".repeat(64), name: "截图", kind: "image", status: "ready", previewUrl: "/api/teams/media/"+"a".repeat(64) };
const later = { chatId: "chat", id: "2", chatLabel: "原聊天", sender: "乙", createdAt: "2026-01-02T00:00:00Z", text: "后一句原话", media: [] };
const first = { ...later, id: "1", sender: "甲", createdAt: "2026-01-01T00:00:00Z", text: '<script>这只是原话</script>\n第二段', media: [image] };
const output = '<teams-records>'+JSON.stringify([later,first])+'</teams-records>';
const activity: ToolActivity = { id: "call", name: "teams_history", status: "completed", text: output };

test("多页逆序与重叠结果按原时间合并，截图跟随原消息，原文转义且保留段落", () => {
  const records = teamsRecords([activity,activity]);
  assert.deepEqual(records.map(r => r.id), ["1","2"]);
  const html = renderToStaticMarkup(createElement(TeamsRecords,{records}));
  assert.ok(html.indexOf('data-teams-message-id="1"')<html.indexOf('data-teams-message-id="2"'));
  const firstBlock=html.slice(html.indexOf('data-teams-message-id="1"'),html.indexOf('data-teams-message-id="2"'));
  assert.match(firstBlock, /<img/); assert.match(firstBlock, /甲/); assert.match(firstBlock, /第二段/);
  assert.doesNotMatch(html, /<script>/); assert.match(html, /&lt;script&gt;/);
});

test("真实记录内嵌在普通回复中，附件跟随消息，助手解释直接可见且过程仍保留", () => {
  const view: ConversationView={conversationId:1,entries:[{id:1,kind:"user",text:"按真实聊天整理"},{id:2,kind:"tool",name:"teams_history",text:output},{id:3,kind:"assistant",text:"模型对截图的分析"}],busy:false,live:{},inbox:0,usage:null,notes:{todos:[],memos:[]},tasks:[],reminders:[],subagents:[],parentId:null};
  const html=renderToStaticMarkup(createElement(ChatThread,{view}));
  assert.match(html,/teams-records-inline/);assert.doesNotMatch(html,/user-attachments-grid teams-media-inline/);
  assert.match(html,/<details class="teams-records-chat" open="">/);
  assert.doesNotMatch(html,/teams-records-summary/);
  assert.match(html,/assistant-bubble md[^]*模型对截图的分析/);
  assert.match(html,/turn-activities/);
  assert.ok(html.indexOf("teams-records-inline") < html.indexOf("assistant-bubble md"));
  assert.ok(html.indexOf("assistant-bubble md") < html.indexOf("turn-activities"));
  assert.match(html,/后一句原话/);
});

test("最新 Teams 缓存查询按聊天分块显示，保留双方原话而不依赖助手摘要", () => {
  const records = [
    { ...first, direction: "in" },
    { ...later, direction: "out", text: "收到" },
    { ...later, id: "other", chatId: "other-chat", chatLabel: "另一个聊天", direction: "in" },
  ];
  const view: ConversationView = { conversationId: 1, entries: [
    { id: 1, kind: "user", text: "最新的teams 消息" },
    { id: 2, kind: "tool", name: "teams_messages", text: `Teams 已同步至今天。\n<teams-records>${JSON.stringify(records)}</teams-records>\n界面展示原消息。` },
    { id: 3, kind: "assistant", text: "已读取最近 3 条缓存消息。" },
  ], busy: false, live: {}, inbox: 0, usage: null, notes: { todos: [], memos: [] }, tasks: [], reminders: [], subagents: [], parentId: null };
  const html = renderToStaticMarkup(createElement(ChatThread, { view }));
  assert.equal((html.match(/class="teams-records-chat"/g) ?? []).length, 2);
  assert.match(html, /data-direction="in"/);
  assert.match(html, /data-direction="out"/);
  assert.match(html, /收到/);
  assert.match(html, /已读取最近 3 条缓存消息/);
  assert.ok(html.indexOf("teams-records-inline") < html.indexOf("assistant-bubble md"));
});

test("方向仅取可信字段，旧记录不猜身份，连续本人消息分组且跨日重新显示发送者", async t => {
  const rows = [
    { ...later, id: "a", createdAt: new Date(2026, 10, 9, 23, 59, 3).toISOString(), direction: "out" },
    { ...later, id: "b", createdAt: new Date(2026, 10, 9, 23, 59, 40).toISOString(), direction: "out" },
    { ...later, id: "c", createdAt: new Date(2026, 10, 10, 0, 0).toISOString(), direction: "out" },
    { ...later, id: "d", createdAt: new Date(2026, 10, 10, 0, 1).toISOString(), direction: "me" },
  ];
  const records = teamsRecords([{ ...activity, text: `<teams-records>${JSON.stringify(rows)}</teams-records>` }]);
  assert.deepEqual(records.map(record => record.direction), ["out", "out", "out", "unknown"]);
  const { dom } = await mount(t, <TeamsRecords records={records} onQuote={() => {}} />), doc = dom.window.document;
  const messages = [...doc.querySelectorAll<HTMLElement>(".teams-record")];
  assert.equal(messages[0].dataset.direction, "out");
  assert.equal(messages[1].classList.contains("is-grouped"), true);
  assert.equal(messages[2].classList.contains("is-grouped"), false);
  assert.equal(messages[3].dataset.direction, "unknown");
  assert.match(messages[0].textContent!, /乙 · 我/);
  assert.doesNotMatch(messages[3].textContent!, /· 我/);
  assert.ok(messages[2].querySelector(".teams-record-day"));
});

test("多个聊天分别折叠，引用保留原消息，删除记录不暴露旧正文、图片或引用动作", async t => {
  const records = teamsRecords([{ ...activity, text: `<teams-records>${JSON.stringify([first, { ...later, chatId: "other", deleted: true, text: "应隐藏的旧正文", media: [image] }])}</teams-records>` }]);
  let quoted: unknown;
  const { dom } = await mount(t, <TeamsRecords records={records} onQuote={record => { quoted = record; }} />), doc = dom.window.document;
  const chats = [...doc.querySelectorAll<HTMLDetailsElement>(".teams-records-chat")];
  assert.equal(chats.length, 2);
  assert.ok(chats.every(chat => chat.open));
  assert.equal(chats[0].querySelector('[role="region"]')?.getAttribute("tabindex"), "0");
  await act(async () => chats[0].querySelector<HTMLButtonElement>(".teams-record-quote")!.click());
  assert.equal(quoted, records[0]);
  assert.equal(chats[1].querySelector("img"), null);
  assert.equal(chats[1].querySelector(".teams-record-quote"), null);
  assert.doesNotMatch(chats[1].textContent!, /应隐藏的旧正文/);
  await act(async () => chats[0].querySelector("summary")!.click());
  assert.equal(chats[0].open, false);
  assert.equal(chats[1].open, true);
});
