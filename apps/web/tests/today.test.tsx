import test from "node:test";
import assert from "node:assert/strict";
import { act } from "react";
import type { ReactNode } from "react";
import type { TestContext } from "node:test";
import type { DaylightSnapshot, DaylightTask, PersonalData, WorkspaceActivity, WorkspaceActivities, WorkspaceMail } from "@assistant/contracts";
import { TodayPage } from "../dist/today/TodayPage.js";
import type { TodayPageProps } from "../dist/today/TodayPage.js";
import { ActivityPage } from "../dist/today/ActivityPage.js";
import { selectTodayTasks } from "../dist/today/model.js";
import { localDate } from "../dist/daylight/domain/todo.js";
import { apiClient } from "../dist/api/socket.js";
import { mount } from "./dom.js";

function task(id: string, dueDate: string | null, patch: Partial<DaylightTask> = {}): DaylightTask {
  return { id, title: id, projectId: "project-a", description: "", status: "todo", priority: "medium", color: "rose", dueDate, tags: [], checklist: [], createdAt: 1, position: 1, ...patch };
}
function activity(id: string, owner: number, patch: Partial<WorkspaceActivity> = {}): WorkspaceActivity {
  return { id, kind: "reminder", conversationId: owner, conversationTitle: `来源 ${owner}`, text: `事项 ${owner}`, status: "scheduled", at: 1_800_000_000_000, createdAt: 1_799_000_000_000, ...patch };
}
function fixtures() {
  const daylight: DaylightSnapshot = { projects: [{ id: "project-a", name: "迁移工作台", description: "", color: "rose" }], tasks: [] };
  const personal: PersonalData = { memory: [], skills: [], knowledge: { enabled: false, allow: [] } };
  const activities: WorkspaceActivities = { items: [], total: 0, truncated: false };
  const mail: WorkspaceMail = { status: { enabled: true, connected: true, offline: false, syncing: false, lastSuccessAt: "2026-10-22T06:30:00Z", error: "" }, messages: [] };
  return { daylight, personal, activities, mail };
}
function mockResources(t: TestContext, values: ReturnType<typeof fixtures>) {
  t.mock.method(apiClient, "request", async (path: string) => {
    if (path === "/api/daylight") return values.daylight;
    if (path === "/api/personal") return values.personal;
    if (path === "/api/workspace/activities") return values.activities;
    if (path === "/api/workspace/mail") return values.mail;
    throw new Error(`Unexpected request: ${path}`);
  });
}
const noop = () => {};
function todayProps(patch: Partial<TodayPageProps> = {}): Omit<TodayPageProps, "active"> {
  return { onPrompt: noop, onGroup: noop, onDaylight: noop, onActivities: noop, onSettings: noop, onConversation: noop, ...patch };
}
async function mountVisible(t: TestContext, content: (active: boolean) => ReactNode) {
  const view = await mount(t, content(false));
  Object.defineProperty(view.dom.window.document, "visibilityState", { configurable: true, value: "visible" });
  await view.render(content(true));
  return view;
}

test("今日待办按本地日期区分逾期、今日和未来，排除已完成与未定日期", () => {
  const values = fixtures();
  values.daylight.tasks = [task("逾期", "2026-10-21"), task("今天", "2026-10-22"), task("未来", "2026-10-23"), task("已完成", "2026-10-20", { status: "done" }), task("未定日期", null), task("进行中", null, { status: "doing" }), task("待确认", null, { status: "review" })];
  const result = selectTodayTasks(values.daylight, "2026-10-22");
  assert.deepEqual(result.due.map(item => item.id), ["逾期", "今天"]);
  assert.equal(result.overdue, 1);
  assert.equal(result.today, 1);
  assert.equal(result.doing, 1);
  assert.equal(result.review, 1);
});

test("工作台展示真实来源项目，并通过现有入口打开待办与审批", async t => {
  const values = fixtures();
  values.daylight.tasks = [task("到期待办", localDate()), task("已完成不显示", localDate(), { status: "done" })];
  values.personal.memory = [{ id: "pending-memory", status: "pending", source: "agent", text: "候选偏好", createdAt: 1, decidedAt: null }];
  mockResources(t, values);
  const openedTasks: (string | undefined)[] = [];
  const groups: string[] = [];
  const props = todayProps({ onDaylight: taskId => { openedTasks.push(taskId); }, onGroup: group => { groups.push(group); } });
  const { dom } = await mountVisible(t, active => <TodayPage {...props} active={active} />);
  const document = dom.window.document;
  assert.match(document.querySelector(".today-task-list")!.textContent!, /到期待办.*Daylight · 迁移工作台/);
  assert.doesNotMatch(document.querySelector(".today-task-list")!.textContent!, /已完成不显示/);
  await act(async () => {
    document.querySelector<HTMLButtonElement>(".today-task-button")!.click();
    document.querySelector<HTMLButtonElement>(".today-approval-link")!.click();
  });
  assert.deepEqual(openedTasks, ["到期待办"]);
  await act(async () => { document.querySelector<HTMLButtonElement>(".today-task-footer button")!.click(); });
  assert.deepEqual(openedTasks, ["到期待办", undefined]);
  assert.deepEqual(groups, ["memory"]);
  assert.match(document.querySelector(".today-approval-links")!.textContent!, /1 条等待批准/);
});

test("局部请求失败和不完整响应显示错误，不误报整个工作台为空", async t => {
  const values = fixtures();
  values.activities.items = [activity("job", 19, { kind: "background", status: "running", text: "正在整理真实资料", at: null })];
  values.activities.total = 1;
  t.mock.method(apiClient, "request", async (path: string) => {
    if (path === "/api/daylight") throw new Error("待办服务暂时不可用");
    if (path === "/api/personal") return {};
    if (path === "/api/workspace/activities") return values.activities;
    if (path === "/api/workspace/mail") return values.mail;
    throw new Error(`Unexpected request: ${path}`);
  });
  const { dom } = await mountVisible(t, active => <TodayPage {...todayProps()} active={active} />);
  const document = dom.window.document;
  assert.match(document.querySelector('.today-panel-tasks [role="alert"]')!.textContent!, /待办服务暂时不可用/);
  assert.match(document.querySelector('.today-panel-approvals [role="alert"]')!.textContent!, /数据格式不完整/);
  assert.equal(document.querySelector(".today-task-totals"), null);
  assert.equal(document.querySelector(".today-panel-tasks .today-empty"), null);
  assert.equal(document.querySelector(".today-approval-links"), null);
  assert.match(document.querySelector(".today-panel-progress")!.textContent!, /正在整理真实资料/);
  assert.equal(document.querySelector('.today-panel-progress [role="alert"]'), null);
});

test("外部待办、邮件、会话和任务结果按纯文本显示，不注入 HTML", async t => {
  const values = fixtures();
  const externalText = '<img src=x onerror="alert(1)"><script>external()</script> & 原文';
  values.daylight.tasks = [task("external", localDate(), { title: externalText })];
  values.mail.messages = [{ id: "message", subject: externalText, sender: externalText, address: "cached@example.test", receivedAt: "2026-10-22T06:00:00Z", preview: externalText, isRead: false, hasAttachments: true }];
  values.activities.items = [activity("result", 47, { kind: "background", status: "done", conversationTitle: externalText, text: externalText, result: externalText })];
  values.activities.total = 1;
  mockResources(t, values);
  const { dom } = await mountVisible(t, active => <><TodayPage {...todayProps()} active={active} /><ActivityPage active={active} onConversation={noop} onManage={noop} /></>);
  const document = dom.window.document;
  assert.equal(document.querySelector("img, script"), null);
  assert.equal(document.querySelector(".today-task-copy strong")!.textContent, externalText);
  assert.match(document.querySelector(".today-mail-list h3")!.textContent!, /<script>external\(\)<\/script>/);
  assert.equal(document.querySelector(".activity-record-result pre")!.textContent, externalText);
});

test("统一进展筛选保留真实状态，来源和管理都指向正确父会话", async t => {
  const values = fixtures();
  values.activities = { items: [activity("same-id", 17), activity("same-id", 42, { kind: "background", status: "done", text: "后台已结束", result: "结果正文", at: null }), activity("paused", 71, { kind: "schedule", status: "paused" })], total: 8, truncated: true };
  mockResources(t, values);
  const conversations: number[] = [], managed: number[] = [];
  const { dom } = await mountVisible(t, active => <ActivityPage active={active} onConversation={id => { conversations.push(id); }} onManage={id => { managed.push(id); }} />);
  const document = dom.window.document;
  assert.equal(document.querySelectorAll(".activity-record-list .activity-record").length, 3);
  assert.match(document.querySelector(".activity-truncation")!.textContent!, /3 \/ 8/);
  const resultRecord = [...document.querySelectorAll<HTMLElement>(".activity-record-list .activity-record")].find(item => item.textContent!.includes("后台已结束"))!;
  await act(async () => { resultRecord.querySelector<HTMLButtonElement>(".activity-source-button")!.click(); resultRecord.querySelector<HTMLButtonElement>(".activity-record-actions button")!.click(); });
  assert.deepEqual(conversations, [42]);
  assert.deepEqual(managed, [42]);
  assert.equal(resultRecord.querySelector("details pre")!.textContent, "结果正文");
  await act(async () => { [...document.querySelectorAll<HTMLButtonElement>(".activity-filter")].find(button => button.textContent!.startsWith("待处理"))!.click(); });
  assert.equal(document.querySelectorAll(".activity-record-list .activity-record").length, 2);
  assert.match(document.querySelector(".activity-record-list")!.textContent!, /已暂停/);
  assert.doesNotMatch(document.querySelector(".activity-record-list")!.textContent!, /后台已结束/);
});

test("页面未激活或后台隐藏时不轮询，忽略切换前未完成请求的旧回包", async t => {
  const oldData: WorkspaceActivities = { items: [activity("old", 10, { text: "旧请求内容" })], total: 1, truncated: false };
  const newData: WorkspaceActivities = { items: [activity("new", 20, { text: "新请求内容" })], total: 1, truncated: false };
  let resolveOld: (value: WorkspaceActivities) => void = noop;
  let requests = 0, readRequests = 0;
  t.mock.method(apiClient, "request", async (path: string) => {
    if (path === "/api/notifications/reads") { readRequests++; return { keys: [] }; }
    assert.equal(path, "/api/workspace/activities");
    requests++;
    if (requests === 1) return new Promise<WorkspaceActivities>(resolve => { resolveOld = resolve; });
    return newData;
  });
  const content = (active: boolean) => <ActivityPage active={active} onConversation={noop} onManage={noop} />;
  const view = await mount(t, content(false));
  assert.equal(requests, 0);
  assert.equal(readRequests, 0);
  const intervals: { callback: () => void; delay: number | undefined; id: number }[] = [];
  const cleared: (number | undefined)[] = [];
  t.mock.method(view.dom.window, "setInterval", (handler: TimerHandler, delay?: number) => {
    const id = intervals.length + 1;
    intervals.push({ callback: () => { if (typeof handler === "function") handler(); }, delay, id });
    return id;
  });
  t.mock.method(view.dom.window, "clearInterval", (id?: number) => { cleared.push(id); });
  Object.defineProperty(view.dom.window.document, "visibilityState", { configurable: true, value: "visible" });
  await view.render(content(true));
  assert.equal(requests, 1);
  assert.equal(readRequests, 1);
  assert.equal(intervals[0].delay, 30_000);
  await view.render(content(false));
  await view.render(content(true));
  assert.equal(requests, 2);
  await act(async () => { resolveOld(oldData); });
  assert.match(view.dom.window.document.querySelector(".activity-record-list")!.textContent!, /新请求内容/);
  assert.doesNotMatch(view.dom.window.document.querySelector(".activity-record-list")!.textContent!, /旧请求内容/);
  Object.defineProperty(view.dom.window.document, "visibilityState", { configurable: true, value: "hidden" });
  await act(async () => { view.dom.window.document.dispatchEvent(new view.dom.window.Event("visibilitychange")); });
  await view.render(content(false));
  await view.render(content(true));
  assert.equal(requests, 2);
  assert.equal(readRequests, 2);
});


test("首页优先显示失败事项，截断时只报告已加载数量，失败仍属于已结束", async t => {
  const values = fixtures();
  values.activities = { items: [
    ...Array.from({ length: 4 }, (_, index) => activity(`running-${index}`, 20 + index, { kind: "background", status: "running", text: `正在推进 ${index}` })),
    activity("failed", 83, { kind: "background", status: "failed", text: "需要处理的失败", result: "真实失败原因" }),
    activity("done", 91, { kind: "background", status: "done", text: "已经完成" }),
  ], total: 250, truncated: true };
  mockResources(t, values);
  const opened: number[] = [];
  const { dom } = await mountVisible(t, active => <><TodayPage {...todayProps({ onConversation: id => opened.push(id) })} active={active} /><ActivityPage active={active} onConversation={noop} onManage={noop} /></>);
  const document = dom.window.document;
  assert.match(document.querySelector(".today-progress-attention")!.textContent!, /已加载记录中有 1 项执行失败/);
  const first = document.querySelector(".today-progress-list .activity-record")!;
  assert.match(first.textContent!, /需要处理的失败/);
  await act(async () => { first.querySelector<HTMLButtonElement>(".activity-source-button")!.click(); });
  assert.deepEqual(opened, [83]);
  const filter = async (label: string) => { await act(async () => { [...document.querySelectorAll<HTMLButtonElement>(".activity-filter")].find(button => button.textContent!.startsWith(label))!.click(); }); };
  await filter("执行失败");
  assert.equal(document.querySelectorAll(".activity-record-list .activity-record").length, 1);
  assert.match(document.querySelector(".activity-record-list")!.textContent!, /需要处理的失败/);
  await filter("已结束");
  assert.equal(document.querySelectorAll(".activity-record-list .activity-record").length, 2);
});

test("只有失败事项时首页仍提供来源入口，不显示没有事项的空态", async t => {
  const values = fixtures();
  values.activities = { items: [activity("failure-only", 42, { kind: "background", status: "failed", text: "后台整理失败" })], total: 1, truncated: false };
  mockResources(t, values);
  const { dom } = await mountVisible(t, active => <TodayPage {...todayProps()} active={active} />);
  const panel = dom.window.document.querySelector(".today-panel-progress")!;
  assert.match(panel.textContent!, /1 项执行失败/);
  assert.match(panel.textContent!, /后台整理失败/);
  assert.equal(panel.querySelector(".today-empty"), null);
});
