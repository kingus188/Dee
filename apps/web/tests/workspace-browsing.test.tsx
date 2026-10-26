import test from "node:test";
import assert from "node:assert/strict";
import { act } from "react";
import type { JSDOM } from "jsdom";
import type { ConversationView, Management, Reminder, Schedule } from "@assistant/contracts";
import { NotesPage } from "../dist/workspace/NotesPage.js";
import { TasksPage } from "../dist/workspace/TasksPage.js";
import { apiClient } from "../dist/api/socket.js";
import { mount } from "./dom.js";

type Notes = ConversationView["notes"];
const emptyManagement = (): Management => ({ schedules: [], reminders: [], background: [] });

function button(document: Document, label: string) {
  const found = [...document.querySelectorAll<HTMLButtonElement>("button")].find(item => item.textContent === label || item.getAttribute("aria-label") === label);
  assert.ok(found, `Missing button: ${label}`);
  return found;
}

async function click(document: Document, label: string) {
  await act(async () => { button(document, label).click(); });
}

function assertBrowsing(document: Document) {
  assert.equal(document.querySelector("[contenteditable='true'], textarea, input:not([type='search']), select, form, .markdown-editor, .workspace-edit-form"), null);
}

async function source(dom: JSDOM) {
  const document = dom.window.document;
  if (!document.querySelector(".markdown-editor textarea")) await click(document, "Markdown 源码");
  const textarea = document.querySelector<HTMLTextAreaElement>(".markdown-editor textarea");
  assert.ok(textarea);
  return textarea;
}

async function typeMarkdown(dom: JSDOM, text: string) {
  const textarea = await source(dom);
  await act(async () => {
    Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, text);
    textarea.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  });
}

async function changeValue(dom: JSDOM, element: HTMLInputElement | HTMLSelectElement, value: string) {
  await act(async () => {
    const prototype = element.tagName === "SELECT" ? dom.window.HTMLSelectElement.prototype : dom.window.HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(element, value);
    element.dispatchEvent(new dom.window.Event(element.tagName === "SELECT" ? "change" : "input", { bubbles: true }));
  });
}

test("笔记默认浏览列表，条目先只读 Markdown，再显式编辑并取消返回详情", async t => {
  const original: Notes = { todos: [], memos: ["## 项目记录\n\n保留 **原始格式**\n\n<script>alert(1)</script>"] };
  const requests: string[] = [];
  t.mock.method(apiClient, "request", async (path: string) => { requests.push(path); return original; });
  const { dom } = await mount(t, <NotesPage owner={7} active />), document = dom.window.document;
  assertBrowsing(document);
  assert.equal(document.querySelectorAll(".workspace-record-select").length, 1);
  await act(async () => { document.querySelector<HTMLButtonElement>(".workspace-record-select")!.click(); });
  assertBrowsing(document);
  assert.equal(document.querySelector(".workspace-reading strong")!.textContent, "原始格式");
  assert.equal(document.querySelector(".workspace-reading script"), null);
  assert.match(document.querySelector(".workspace-reading .md")!.textContent!, /<script>alert\(1\)<\/script>/);
  await click(document, "编辑笔记");
  assert.equal((await source(dom)).value, original.memos[0]);
  await click(document, "取消编辑");
  assertBrowsing(document);
  assert.ok(document.querySelector('[aria-label="笔记详情"]'));
  await click(document, "返回笔记列表");
  assertBrowsing(document);
  assert.equal(document.querySelectorAll(".workspace-record-select").length, 1);
  assert.deepEqual(requests, ["/api/conversations/7/notes"], "阅读、编辑和取消都不提交或重读内容");
});

test("空笔记先显示空状态，新增保存使用原 base 并返回只读详情", async t => {
  let stored: Notes = { todos: [], memos: [] };
  const original = stored, writes: { notes: Notes; base: Notes }[] = [];
  t.mock.method(apiClient, "request", async (_path: string, body?: { notes: Notes; base: Notes }) => {
    if (!body) return stored;
    writes.push(body); stored = body.notes; return stored;
  });
  const { dom } = await mount(t, <NotesPage owner={7} active />), document = dom.window.document;
  assertBrowsing(document);
  assert.match(document.querySelector(".workspace-content-empty")!.textContent!, /从一个想法开始/);
  await click(document, "新增笔记");
  assert.ok(document.querySelector('[aria-label="笔记编辑"]'));
  await click(document, "取消编辑");
  assertBrowsing(document);
  await click(document, "新增笔记");
  const markdown = "## 新笔记\n\n- 完整保存";
  await typeMarkdown(dom, markdown);
  await click(document, "保存笔记");
  assert.deepEqual(writes, [{ notes: { todos: [], memos: [markdown] }, base: original }]);
  assertBrowsing(document);
  assert.match(document.querySelector(".workspace-reading .md")!.textContent!, /新笔记/);
  assert.equal(document.querySelector('[role="status"]')!.textContent, "已保存");
  await click(document, "编辑笔记");
  assert.equal((await source(dom)).value, markdown);
});

test("笔记冲突保留草稿和编辑状态，切页不丢失，取消与重读复用放弃确认", async t => {
  const original: Notes = { todos: [], memos: ["已保存笔记"] };
  let reads = 0, writes = 0;
  t.mock.method(apiClient, "request", async (_path: string, body?: unknown) => {
    if (!body) { reads++; return original; }
    writes++; throw new Error("笔记已被其他页面更新");
  });
  const view = await mount(t, <NotesPage owner={7} active />), { dom } = view, document = dom.window.document;
  let discard = false, confirmations = 0;
  t.mock.method(dom.window, "confirm", (message: string) => { confirmations++; assert.match(message, /有未保存的修改/); return discard; });
  await act(async () => { document.querySelector<HTMLButtonElement>(".workspace-record-select")!.click(); });
  await click(document, "编辑笔记");
  await typeMarkdown(dom, "尚未保存的修改");
  await click(document, "保存笔记");
  assert.match(document.querySelector('[role="alert"]')!.textContent!, /其他页面更新.*草稿已保留/);
  assert.equal((await source(dom)).value, "尚未保存的修改");
  await view.render(<NotesPage owner={7} active={false} />);
  await view.render(<NotesPage owner={7} active />);
  assert.equal((await source(dom)).value, "尚未保存的修改");
  await click(document, "取消编辑");
  await click(document, "重新读取");
  await click(document, "新增笔记");
  assert.equal(confirmations, 3);
  assert.equal((await source(dom)).value, "尚未保存的修改");
  assert.equal(reads, 1);
  assert.equal(writes, 1);
  const leaving = new dom.window.Event("beforeunload", { cancelable: true });
  dom.window.dispatchEvent(leaving);
  assert.equal(leaving.defaultPrevented, true);
  discard = true;
  await click(document, "取消编辑");
  assertBrowsing(document);
  assert.match(document.querySelector(".workspace-reading .md")!.textContent!, /已保存笔记/);
  const afterCancel = new dom.window.Event("beforeunload", { cancelable: true });
  dom.window.dispatchEvent(afterCancel);
  assert.equal(afterCancel.defaultPrevented, false);
});

test("任务默认保留各类列表与管理能力，编辑计划发送 revision 后返回浏览", async t => {
  const schedule: Schedule = { id: "plan", text: "## 周会准备", nextAt: Date.now() + 600000, everyMinutes: 60, runs: 2, lastRunAt: null, status: "paused", revision: 8, createdAt: 1 };
  const reminder: Reminder = { id: 3, text: "带上会议资料", at: Date.now() + 600000, status: "scheduled" };
  let data: Management = { schedules: [schedule], reminders: [reminder], background: [{ id: "job", text: "后台整理", status: "running", conversationId: null, createdAt: 1, result: null }] };
  const writes: { path: string; body: Record<string, unknown> }[] = [];
  t.mock.method(apiClient, "request", async (path: string, body?: Record<string, unknown>) => {
    if (!body) return data;
    writes.push({ path, body });
    const item = { ...schedule, text: String(body.text), revision: 9 };
    data = { ...data, schedules: [item] }; return { item };
  });
  const { dom } = await mount(t, <TasksPage owner={7} active />), document = dom.window.document;
  assertBrowsing(document);
  assert.equal(document.querySelectorAll(".workspace-task").length, 3);
  for (const label of ["继续", "取消计划", "取消提醒", "停止任务"]) assert.ok(button(document, label));
  await click(document, "编辑计划");
  assert.equal((await source(dom)).value, schedule.text);
  assert.equal(document.querySelector<HTMLSelectElement>("select")!.disabled, true);
  await click(document, "取消编辑");
  assertBrowsing(document);
  await click(document, "编辑计划");
  await typeMarkdown(dom, "## 更新后的周会准备");
  await click(document, "保存安排");
  assert.equal(writes.length, 1);
  assert.equal(writes[0].path, "/api/conversations/7/schedules/plan/edit");
  assert.equal(writes[0].body.revision, 8);
  assert.equal(writes[0].body.everyMinutes, 60);
  assert.equal(typeof writes[0].body.requestId, "string");
  assertBrowsing(document);
  assert.match(document.querySelector('[aria-label="任务列表"]')!.textContent!, /更新后的周会准备/);
  assert.match(document.querySelector('[role="status"]')!.textContent!, /已保存安排/);
});

test("提醒失败保留正文、时间和 at，切页刷新列表不覆盖草稿，取消受 mayDiscard 保护", async t => {
  const reminder: Reminder = { id: 3, text: "原提醒", at: Date.now() + 600000, status: "scheduled" };
  const writes: Record<string, unknown>[] = [];
  let data: Management = { ...emptyManagement(), reminders: [reminder] };
  t.mock.method(apiClient, "request", async (_path: string, body?: Record<string, unknown>) => {
    if (!body) return data;
    writes.push(body); throw new Error("提醒已变更，请刷新后重试");
  });
  const view = await mount(t, <TasksPage owner={7} active />), { dom } = view, document = dom.window.document;
  let discard = false, confirmations = 0;
  t.mock.method(dom.window, "confirm", () => { confirmations++; return discard; });
  await click(document, "编辑提醒");
  await typeMarkdown(dom, "改为提前准备资料");
  await changeValue(dom, document.querySelector<HTMLInputElement>('input[type="number"]')!, "25");
  await click(document, "保存安排");
  assert.match(document.querySelector('[role="alert"]')!.textContent!, /提醒已变更.*正文保留/);
  assert.equal(writes[0].at, reminder.at);
  assert.equal(writes[0].minutesFromNow, 25);
  data = { ...data, reminders: [{ ...reminder, text: "另一页面的新内容", at: reminder.at + 1000 }] };
  await view.render(<TasksPage owner={7} active={false} />);
  await view.render(<TasksPage owner={7} active />);
  assert.match(document.querySelector('[aria-label="任务列表"]')!.textContent!, /另一页面的新内容/);
  assert.equal((await source(dom)).value, "改为提前准备资料");
  assert.equal(document.querySelector<HTMLInputElement>('input[type="number"]')!.value, "25");
  await click(document, "保存安排");
  assert.equal(writes[1].at, reminder.at, "刷新不替换草稿的原版本");
  assert.equal(writes[1].requestId, writes[0].requestId);
  await click(document, "取消编辑");
  await click(document, "新增安排");
  assert.equal(confirmations, 2);
  assert.equal((await source(dom)).value, "改为提前准备资料");
  discard = true;
  await click(document, "取消编辑");
  assertBrowsing(document);
  assert.match(document.querySelector('[aria-label="任务列表"]')!.textContent!, /另一页面的新内容/);
});

test("空任务显式新增，失败重试使用同一 requestId，等待时重复保存只发一次", async t => {
  let data = emptyManagement(), fail = true;
  const writes: { path: string; body: Record<string, unknown> }[] = [];
  let resolveSave: ((value: { item: Reminder }) => void) | undefined;
  t.mock.method(apiClient, "request", async (path: string, body?: Record<string, unknown>) => {
    if (!body) return data;
    writes.push({ path, body });
    if (fail) throw new Error("连接中断");
    return new Promise<{ item: Reminder }>(resolve => { resolveSave = resolve; });
  });
  const { dom } = await mount(t, <TasksPage owner={7} active />), document = dom.window.document;
  assertBrowsing(document);
  assert.match(document.querySelector(".workspace-content-empty")!.textContent!, /还没有安排/);
  await click(document, "新增安排");
  await click(document, "取消编辑");
  assertBrowsing(document);
  await click(document, "新增安排");
  await typeMarkdown(dom, "确认发布记录");
  await click(document, "创建安排");
  assert.match(document.querySelector('[role="alert"]')!.textContent!, /连接中断/);
  assert.equal((await source(dom)).value, "确认发布记录");
  fail = false;
  const save = button(document, "创建安排");
  await act(async () => { save.click(); save.click(); });
  assert.equal(writes.length, 2, "第一次失败加一次重试，不发送第三次");
  assert.equal(writes[1].body.requestId, writes[0].body.requestId);
  assert.equal(writes[1].path, "/api/conversations/7/reminders");
  assert.equal(button(document, "处理中…").disabled, true);
  assert.equal(button(document, "取消编辑").disabled, true);
  assert.equal(button(document, "新增安排").disabled, true);
  const item: Reminder = { id: 4, text: String(writes[1].body.text), at: Date.now() + 600000, status: "scheduled" };
  data = { ...data, reminders: [item] };
  assert.ok(resolveSave);
  await act(async () => { resolveSave!({ item }); });
  assertBrowsing(document);
  assert.match(document.querySelector('[aria-label="任务列表"]')!.textContent!, /确认发布记录/);
  assert.ok(button(document, "取消提醒"));
});

test("新增后台任务保留类型选择与停止能力，保存后回列表且管理操作不展开编辑器", async t => {
  let data = emptyManagement();
  const paths: string[] = [];
  t.mock.method(apiClient, "request", async (path: string, body?: Record<string, unknown>) => {
    if (!body) return data;
    paths.push(path);
    if (path.endsWith("/stop")) { data = { ...data, background: [{ ...data.background[0], status: "cancelled" }] }; return {}; }
    const item = { id: "job", text: String(body.text), status: "running" as const, conversationId: null, createdAt: 1, result: null };
    data = { ...data, background: [item] }; return { item };
  });
  const { dom } = await mount(t, <TasksPage owner={7} active />), document = dom.window.document;
  await click(document, "新增安排");
  await changeValue(dom, document.querySelector<HTMLSelectElement>("select")!, "background");
  await typeMarkdown(dom, "整理会议纪要");
  assert.equal(document.querySelector('input[type="number"]'), null);
  await click(document, "启动任务");
  assertBrowsing(document);
  assert.match(document.querySelector('[role="status"]')!.textContent!, /已启动后台任务/);
  await click(document, "停止任务");
  assertBrowsing(document);
  assert.deepEqual(paths, ["/api/conversations/7/background", "/api/conversations/7/background/job/stop"]);
  assert.match(document.querySelector('[aria-label="任务列表"]')!.textContent!, /已停止/);
});

test("笔记读取失败展示错误和重试入口，重试成功仍为浏览状态", async t => {
  let fail = true;
  t.mock.method(apiClient, "request", async () => { if (fail) throw new Error("读取连接中断"); return { todos: [], memos: ["重试读取的笔记"] }; });
  const { dom } = await mount(t, <NotesPage owner={7} active />), document = dom.window.document;
  assertBrowsing(document);
  assert.match(document.querySelector('[role="alert"]')!.textContent!, /读取连接中断/);
  assert.equal(button(document, "新增笔记").disabled, true);
  fail = false;
  await click(document, "重新读取");
  assertBrowsing(document);
  assert.equal(document.querySelector('[role="alert"]'), null);
  assert.match(document.querySelector('[aria-label="笔记列表"]')!.textContent!, /重试读取的笔记/);
});
