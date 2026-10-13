import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createContext, SourceTextModule, SyntheticModule } from "node:vm";
import type { Management, PersonalData, ConversationView } from "@assistant/contracts";
import { managementCards } from "../dist/tasks/management.js";
import { personalCards } from "../dist/personal/panel.js";
import { noteCards } from "../dist/tasks/panels.js";
import { cardGroupsForTurn, visibleCards } from "../dist/tasks/context.js";
import { renderToolFailure } from "../dist/chat/tool-cards.js";
import { emptyCard } from "../dist/tasks/layout.js";
import { createState } from "../dist/state.js";
import type { createConversationCards } from "../dist/tasks/center.js";
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
  assert.equal(cards[1].actions?.length, 1);
  assert.equal(cards[1].actions?.[0].label, "撤回");
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
  const html = renderToolFailure({ id: 1, kind: "tool", isError: true, text: "<img src=x onerror=alert(1)>" });
  assert.match(html, /这一步没有完成/);
  assert.doesNotMatch(html, /<details[^>]*\bopen\b/);
  assert.doesNotMatch(html, /<img /);
  assert.match(html, /&lt;img/);
});

test("切换会话丢弃延迟返回的卡片，提交中的操作不污染新会话", async () => {
  class Node {
    children: ConversationCard[] = [];
    textContent = "";
    scrollHeight = 0;
    scrollTop = 0;
    clientHeight = 800;
    listeners = new Map<string, (event: unknown) => Promise<void>>();
    append(card: ConversationCard) { this.children.push(card); }
    replaceChildren() { this.children = []; }
    querySelectorAll() { return []; }
    addEventListener(name: string, callback: (event: unknown) => Promise<void>) { this.listeners.set(name, callback); }
    contains() { return true; }
    scrollIntoView() {}
  }
  const container = new Node();
  const toolbar = new Node();
  const scroll = new Node();
  const feedback = new Node();
  const requests: { path: string; resolve: (value: unknown) => void; reject: (error: Error) => void }[] = [];
  const context = createContext({
    document: { getElementById: (id: string) => id === "card-feedback" ? feedback : scroll, createElement: () => new Node() },
    window: { setInterval() {} },
  });
  const exports: Record<string, Record<string, unknown>> = {
    "../api/request.js": { request: (path: string) => new Promise((resolve, reject) => requests.push({ path, resolve, reject })) },
    "./layout.js": { createConversationCardLayout: () => ({ container, toolbar }), emptyCard },
    "./management.js": { managementCards },
    "../personal/panel.js": { personalCards },
    "./panels.js": { noteCards },
    "./context.js": { cardGroupsForTurn, visibleCards },
    "../chat/cards.js": { renderConversationCard: (card: ConversationCard) => card },
  };
  const module = new SourceTextModule(await readFile(new URL("../dist/tasks/center.js", import.meta.url), "utf8"), { context });
  await module.link(specifier => {
    const values = exports[specifier];
    assert.ok(values, specifier);
    return new SyntheticModule(Object.keys(values), function () {
      for (const [name, value] of Object.entries(values)) this.setExport(name, value);
    }, { context });
  });
  await module.evaluate();
  const state = createState();
  const actions = { patchChildren: (target: unknown, staging: unknown) => { (target as Node).children = (staging as Node).children; }, insertExamplePrompt() {} };
  const controller = (module.namespace as { createConversationCards: typeof createConversationCards }).createConversationCards(state, () => actions);
  controller.initializeConversationCards();
  state.currentConversationId = 8;
  controller.resetConversationCards();
  state.currentConversationId = 9;
  controller.resetConversationCards();
  await toolbar.listeners.get("click")!({ target: { closest: () => ({ dataset: { cardGroup: "tasks" } }) } });
  requests[4].resolve(schedule()); requests[5].resolve(emptyPersonal);
  requests[2].resolve(schedule()); requests[3].resolve(emptyPersonal);
  await new Promise(resolve => setImmediate(resolve));
  requests[0].resolve({ ...schedule(), schedules: [{ ...schedule().schedules[0], text: "旧会话任务" }] }); requests[1].resolve(emptyPersonal);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(container.children[0].text, "喝水");
  assert.equal(container.children[0].actions?.[0].kind, "request");
  const button = { dataset: { cardAction: "0" }, closest: () => ({ dataset: { cardKey: "schedule:plan" } }) };
  const failed = container.listeners.get("click")!({ target: { closest: () => button } });
  requests[6].reject(new Error("network failure"));
  await failed;
  assert.match(feedback.textContent, /操作未能确认/);
  assert.doesNotMatch(feedback.textContent, /操作已完成/);
  const clicked = container.listeners.get("click")!({ target: { closest: () => button } });
  assert.equal(requests[7].path, "/api/conversations/9/schedules/plan/pause");
  // 重复点击不会产生第二次写入。
  await container.listeners.get("click")!({ target: { closest: () => button } });
  assert.equal(requests.length, 8);
  state.currentConversationId = 10;
  controller.resetConversationCards();
  requests[7].resolve({});
  await clicked;
  assert.equal(feedback.textContent, "");
  assert.equal(container.children.length, 0);
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
