import test from "node:test";
import assert from "node:assert/strict";
import { act } from "react";
import type { ConversationView, DaylightSnapshot, Management, ViewEntry } from "@assistant/contracts";
import { relatedTaskIds, relatedTaskCards } from "../dist/tasks/related.js";
import { CardPanel } from "../dist/tasks/CardPanel.js";
import { App } from "../dist/ui/App.js";
import { apiClient } from "../dist/api/socket.js";
import { mount } from "./dom.js";

const management: Management = { schedules: [], background: [], reminders: [] };
const personal = { memory: [], skills: [], knowledge: { enabled: false, allow: [] } };
const snapshot: DaylightSnapshot = {
  projects: [{ id: "p", name: "界面改进", description: "", color: "sky" }],
  tasks: [{ id: "t", title: "修改页面展示", projectId: "p", description: "请检查页面位置。", status: "todo", priority: "medium", color: "sky", dueDate: "2026-11-10", tags: ["设计"], checklist: [{ id: "c", title: "确认具体位置", done: false }], createdAt: 1, position: 1 },
    { id: "other", title: "其他对话的待办", projectId: "p", description: "", status: "todo", priority: "high", color: "rose", dueDate: null, tags: [], checklist: [], createdAt: 1, position: 2 }],
};
function taskResult(id = "t", name = "update_task"): ViewEntry { return { id: 3, kind: "tool", name, text: JSON.stringify({ ...snapshot.tasks[0], id }) }; }
function conversation(id = 1): ConversationView { return { conversationId: id, channel: "web", entries: [{ id: 1, kind: "user", text: "修改页面展示" }, taskResult(), { id: 4, kind: "assistant", text: "已更新待办。" }], live: {}, busy: false, inbox: 0, notes: { todos: [], memos: [] }, usage: null, tasks: [], reminders: [], subagents: [], parentId: null }; }

test("关联仅来自成功的明确任务结果和持久执行关联，不从全局搜索或标题猜测", () => {
  assert.deepEqual(relatedTaskIds([
    { id: 1, kind: "assistant", text: "", toolCalls: [{ id: "call", name: "create_task", args: {} }] },
    { ...taskResult(), name: undefined, toolCallId: "call" }, taskResult("second", "get_task"), taskResult(),
    { ...taskResult("failed"), isError: true }, { ...taskResult("error"), error: "失败" },
    { ...taskResult("listed"), name: "list_tasks" }, { id: 5, kind: "tool", name: "todo", text: "已添加：修改页面展示" },
    { id: 6, kind: "tool", name: "create_task", text: "not JSON" },
  ], { ...management, background: [{ id: "b", text: "执行", status: "running", conversationId: 9, createdAt: 1, result: null, daylightTaskId: "linked" }] }), ["t", "second", "linked"]);
  const cards = relatedTaskCards(["t", "deleted"], snapshot);
  assert.deepEqual(cards.map(card => card.key), ["daylight:t", "daylight:deleted"]);
  assert.equal(cards[0].daylight?.project, "界面改进");
  assert.equal(cards[0].status, "待开始");
  assert.equal(cards[1].status, "不可用");
  assert.equal(cards[1].daylight, undefined);
  assert.doesNotMatch(JSON.stringify(cards), /其他对话的待办|updatedAt|修改记录/);
});

test("聊天保留紧凑摘要，详情来自最新快照，原任务管理操作仍可访问", async t => {
  const requests: { path: string; body: unknown }[] = [];
  t.mock.method(apiClient, "request", async (path: string, body?: unknown) => {
    requests.push({ path, body });
    if (path === "/api/daylight") return snapshot;
    if (path === "/api/personal") return personal;
    return { ...management, reminders: [{ id: 7, text: "提醒确认页面", at: 1, status: "scheduled" }] };
  });
  const mounted = await mount(t, null), doc = mounted.dom.window.document;
  const host = doc.createElement("div"); doc.body.append(host);
  const counts: number[] = []; let opens = 0;
  await mounted.render(<CardPanel view={conversation()} compactTasks detailsHost={host} onRelatedCount={count => counts.push(count)} onOpenDetails={() => opens++} onPrompt={() => {}} />);
  assert.equal(doc.querySelectorAll("#conversation-cards .related-task-summary").length, 1);
  assert.equal(doc.querySelector("#conversation-cards .conversation-card-actions"), null);
  assert.ok(host.querySelector(".related-task-fields"));
  assert.match(host.textContent!, /界面改进|2026-11-10|确认具体位置/);
  assert.equal(host.querySelectorAll("input[type=checkbox]").length, 0, "只读清单不伪装成可写控件");
  assert.doesNotMatch(host.textContent!, /其他对话的待办|修改记录|更新时间/);
  assert.equal(counts.at(-1), 2);
  await act(async () => { doc.querySelector<HTMLButtonElement>(".related-task-summary")!.click(); });
  assert.equal(opens, 1);
  const select = host.querySelector<HTMLSelectElement>("select")!;
  await act(async () => { select.value = "reminder:7"; select.dispatchEvent(new mounted.dom.window.Event("change", { bubbles: true })); });
  const cancel = [...host.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === "取消提醒")!;
  assert.ok(cancel);
  await act(async () => { cancel.click(); });
  assert.ok(requests.some(item => item.path === "/api/conversations/1/reminders/7/cancel" && item.body !== undefined));
  host.remove();
});

test("失败、删除和过期响应不会展示其他会话或旧任务状态", async t => {
  let release: (value: unknown) => void = () => {};
  t.mock.method(apiClient, "request", async (path: string) => {
    if (path === "/api/personal") return personal;
    if (path === "/api/daylight") return new Promise(resolve => { release = resolve; });
    return management;
  });
  const mounted = await mount(t, <CardPanel view={conversation()} compactTasks onPrompt={() => {}} />);
  await mounted.render(<CardPanel view={{ ...conversation(2), entries: [] }} compactTasks onPrompt={() => {}} />);
  await act(async () => { release(snapshot); });
  assert.equal(mounted.dom.window.document.querySelector(".related-task-summary"), null);
});

test("窄屏关联任务抽屉有模态语义、焦点圈定、Escape 和移除背景限制后恢复焦点", async t => {
  const mounted = await mount(t, null), { dom } = mounted, doc = dom.window.document;
  const focus = dom.window.HTMLElement.prototype.focus;
  t.mock.method(dom.window.HTMLElement.prototype, "focus", function (this: HTMLElement) {
    // JSDOM does not implement inert; model browser behavior so an early focus fails.
    if (!this.closest("[inert]")) focus.call(this);
  });
  dom.window.history.replaceState(null, "", "#chat/1");
  Object.defineProperty(dom.window, "matchMedia", { configurable: true, value: () => ({ matches: true, addEventListener() {}, removeEventListener() {} }) });
  const frame = Object.getOwnPropertyDescriptor(globalThis, "requestAnimationFrame");
  Object.defineProperty(globalThis, "requestAnimationFrame", { configurable: true, value: (callback: FrameRequestCallback) => callback(0) });
  t.after(() => { if (frame) Object.defineProperty(globalThis, "requestAnimationFrame", frame); else Reflect.deleteProperty(globalThis, "requestAnimationFrame"); });
  let receive: (value: ConversationView) => void = () => {};
  t.mock.method(apiClient, "onView", (listener: (value: ConversationView) => void) => { receive = listener; return () => {}; });
  t.mock.method(apiClient, "connect", async () => {});
  t.mock.method(apiClient, "subscribeConversation", async () => { receive(conversation()); });
  t.mock.method(apiClient, "request", async (path: string) => path === "/api/daylight" ? snapshot : path === "/api/personal" ? personal : path === "/api/conversations" ? [{ id: 1, title: "页面展示", createdAt: "2026-11-06" }] : management);
  await mounted.render(<App />);
  const toggle = doc.querySelector<HTMLButtonElement>(".related-panel-toggle")!, panel = doc.querySelector<HTMLElement>("#related-tasks-panel")!;
  assert.ok(toggle);
  assert.equal(panel.hidden, true, "窄屏不自动展开任务详情");
  await act(async () => { toggle.focus(); toggle.click(); });
  assert.equal(panel.hidden, false);
  assert.equal(panel.getAttribute("role"), "dialog");
  assert.equal(panel.getAttribute("aria-modal"), "true");
  assert.equal(doc.querySelector("#workspace")!.getAttribute("inert"), "");
  assert.equal(doc.querySelector(".sidebar")!.getAttribute("inert"), "");
  assert.equal(doc.activeElement?.getAttribute("aria-label"), "收起关联任务");
  await act(async () => { doc.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true, cancelable: true })); });
  assert.equal(doc.activeElement?.getAttribute("href"), "#tasks/t");
  await act(async () => { doc.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true })); });
  assert.equal(doc.activeElement?.getAttribute("aria-label"), "收起关联任务");
  await act(async () => { doc.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
  assert.equal(panel.hidden, true);
  assert.equal(doc.querySelector("#workspace")!.getAttribute("inert"), null);
  assert.equal(doc.activeElement, toggle);
  await act(async () => { toggle.click(); });
  await act(async () => { doc.querySelector<HTMLButtonElement>(".related-panel-backdrop")!.click(); });
  assert.equal(panel.hidden, true);
  await act(async () => { receive({ ...conversation(), channel: "wechat" }); });
  assert.equal(doc.querySelector(".related-panel-toggle"), null);
  assert.equal(panel.hidden, true, "微信仍使用既有外部会话面板");
  assert.equal(doc.querySelector("#conversation-cards .related-task-detail"), null, "来源元数据后补为微信也不会带入待办详情");
});
