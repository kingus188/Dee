import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { teamsRecords, TeamsRecords } from "../dist/chat/TeamsRecords.js";
import { ChatThread } from "../dist/chat/ChatThread.js";
import type { ConversationView } from "@assistant/contracts";
import type { ToolActivity } from "../dist/chat/activities.js";

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

test("有真实记录时不再把图集中在顶部，助手解释默认折叠，过程错误仍保留", () => {
  const view: ConversationView={conversationId:1,entries:[{id:1,kind:"user",text:"按真实聊天整理"},{id:2,kind:"tool",name:"teams_history",text:output},{id:3,kind:"assistant",text:"模型对截图的分析"}],busy:false,live:{},inbox:0,usage:null,notes:{todos:[],memos:[]},tasks:[],reminders:[],subagents:[],parentId:null};
  const html=renderToStaticMarkup(createElement(ChatThread,{view}));
  assert.match(html,/teams-records-inline/);assert.doesNotMatch(html,/user-attachments-grid teams-media-inline/);
  assert.match(html,/<details class="teams-records-summary"><summary>助手说明<\/summary>/);
  assert.doesNotMatch(html,/<details[^>]*teams-records-summary[^>]*open/);
  assert.match(html,/后一句原话/);
});
