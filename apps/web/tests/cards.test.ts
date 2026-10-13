import test from "node:test";
import assert from "node:assert/strict";
import type { Management, PersonalData, ConversationView } from "@assistant/contracts";
import { managementCards } from "../dist/tasks/management.js";
import { personalCards } from "../dist/personal/panel.js";
import { noteCards } from "../dist/tasks/panels.js";
import { cardGroupsForTurn, visibleCards } from "../dist/tasks/context.js";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Card } from "../dist/tasks/CardPanel.js";
import { emptyCard } from "../dist/tasks/layout.js";
import type { ConversationCard } from "../dist/chat/cards.js";

const emptyPersonal: PersonalData = { memory: [], skills: [], knowledge: { enabled: false, allow: [] } };
function schedule(status: Management["schedules"][number]["status"] = "active"): Management {
  return { schedules: [{ id: "plan", text: "喝水", status, nextAt: 10000, everyMinutes: 30, runs: 0, lastRunAt: null, createdAt: 1, revision: 1 }], reminders: [], background: [] };
}

test("任务卡操作绑定原会话，结束的任务不再提供取消或继续", () => {
  const active = managementCards(schedule(), "8")[0];
  assert.deepEqual(active.actions?.map(action => action.kind === "request" ? action.path : ""), [
    "/api/conversations/8/schedules/plan/pause", "/api/conversations/8/schedules/plan/cancel",
  ]);
  assert.equal(managementCards(schedule("paused"), "9")[0].actions?.[0].label, "继续");
  assert.doesNotMatch(managementCards(schedule("paused"), "9")[0].meta!, /下次执行/);
  for (const status of ["cancelled", "completed", "failed"] as const) assert.deepEqual(managementCards(schedule(status), "8")[0].actions, []);
  const reminders = managementCards({ schedules: [], background: [], reminders: [{ id: 2, text: "休息", at: 10, status: "cancelled" }] }, "8");
  assert.equal(reminders[0].status, "已取消");
  assert.deepEqual(reminders[0].actions, []);
  const background: Management = { schedules: [], reminders: [], background: [{ id: "job", text: "整理资料", status: "running", conversationId: 20, createdAt: 1, result: null }] };
  assert.deepEqual(managementCards(background, "8")[0].actions?.map(action => action.label), ["停止任务"]);
  background.background[0].status = "done";
  background.background[0].result = "完整结果".repeat(100);
  const done = managementCards(background, "8")[0];
  assert.deepEqual(done.actions?.map(action => action.label), []);
  assert.equal(done.details, background.background[0].result);

});

test("记忆和技能只有待确认项提供批准动作，默认只显示候选与本次操作结果", () => {
  const data: PersonalData = { ...emptyPersonal, memory: [
    { id: "pending", text: "简洁回答", status: "pending", source: "agent", createdAt: 1, decidedAt: null },
    { id: "approved", text: "中文", status: "approved", source: "user", createdAt: 2, decidedAt: 2 },
    { id: "rejected", text: "旧偏好", status: "rejected", source: "agent", createdAt: 3, decidedAt: 3 },
  ], skills: [{ id: "skill", name: "周报", description: "每周整理", body: "先列进展，再列问题", status: "pending", source: "agent", createdAt: 4, decidedAt: null }] };
  const cards = personalCards(data);
  assert.equal(cards[0].actions?.[0].label, "确认记住");
  assert.deepEqual(cards[1].actions?.map(action => action.label), ["修改", "撤回"]);
  assert.deepEqual(cards[2].actions, []);
  assert.equal(cards[3].details, "先列进展，再列问题");
  assert.deepEqual(visibleCards(cards, null, new Set(), new Set(["memory", "skills"])).map(c => c.key), ["memory:pending", "skills:skill"]);
  assert.ok(visibleCards(cards, null, new Set(["memory:approved"]), new Set()).some(c => c.key === "memory:approved"));
  assert.equal(visibleCards(cards, "skills", new Set(), new Set()).length, 1);
});

test("记录卡从真实待办与备忘生成，空记录不制造完成状态", () => {
  assert.deepEqual(noteCards(undefined), []);
  assert.deepEqual(noteCards({ todos: [], memos: [] }), []);
  const cards = noteCards({ todos: [{ text: "写周报", done: true }, { text: "发周报", done: false }], memos: ["先确认数据"] });
  assert.equal(cards[0].meta, "已完成 1 / 2 项");
  assert.equal(cards[1].text, "先确认数据");
});

test("失败提示保留原因且外部内容不会变成 HTML", () => {
  const html = renderToStaticMarkup(createElement(Card, { card: { key: "failure", group: "tasks", title: "这一步没有完成", text: "请重试", details: "<img src=x onerror=alert(1)>" }, pending: false, onAction() {} }));
  assert.match(html, /这一步没有完成/);
  assert.doesNotMatch(html, /<details[^>]*\bopen\b/);
  assert.doesNotMatch(html, /<img /);
  assert.match(html, /&lt;img/);
});

test("换话题后收起旧任务卡片，只让当前请求涉及的结果自动出现", () => {
  const entries: ConversationView["entries"] = [
    { id: 1, kind: "user", text: "提醒我开会" },
    { id: 2, kind: "assistant", text: "", toolCalls: [{ id: "r", name: "remind_me", args: { text: "开会" } }] },
  ];
  const cards = managementCards(schedule(), "8");
  assert.equal(visibleCards(cards, null, new Set(), cardGroupsForTurn(entries)).length, 1);
  entries.push({ id: 3, kind: "user", text: "晚餐吃什么" });
  assert.equal(visibleCards(cards, null, new Set(), cardGroupsForTurn(entries)).length, 0);
  assert.equal(visibleCards(cards, "tasks", new Set(), cardGroupsForTurn(entries)).length, 1);
});
