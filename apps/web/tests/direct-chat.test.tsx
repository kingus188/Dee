import test from "node:test";
import assert from "node:assert/strict";
import { act, useState } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ConversationView, Management } from "@assistant/contracts";
import { Composer } from "../dist/chat/Composer.js";
import { ChatThread } from "../dist/chat/ChatThread.js";
import { App } from "../dist/ui/App.js";
import { CardPanel } from "../dist/tasks/CardPanel.js";
import { Card } from "../dist/tasks/CardPanel.js";
import { toolActivities } from "../dist/chat/activities.js";
import { apiClient } from "../dist/api/socket.js";
import { mount } from "./dom.js";

test("React 对话按轮次展示、工具折叠、流式回复且内容经过转义", () => {
  const view = {
    conversationId: 7, busy: true, live: { text: "正在**回复**" }, entries: [
      { id: 1, kind: "user", text: "<img src=x onerror=alert(1)>" },
      { id: 2, kind: "assistant", text: "", toolCalls: [{ id: "tool", name: "fetch_page", args: {} }] },
      { id: 3, kind: "tool", name: "fetch_page", text: "<script>secret</script>", isError: true },
      { id: 4, kind: "assistant", text: "已完成 **整理**" },
    ],
  } as ConversationView;
  const html = renderToStaticMarkup(<ChatThread view={view} />);
  assert.match(html, /data-turn-id="1"/);
  assert.match(html, /<details class="turn-activities">/);
  assert.match(html, /有步骤未完成|正在处理/);
  assert.match(html, /已完成 <strong>整理<\/strong>/);
  assert.match(html, /正在<strong>回复<\/strong>/);
  assert.doesNotMatch(html, /<img src=x|<script>/);
});

test("Gina 执行过程把调用和结果合并为一步，停止后不伪造完成", () => {
  const entries: ConversationView["entries"] = [
    { id: 2, kind: "assistant", text: "", toolCalls: [{ id: "a", name: "todo", args: {} }, { id: "b", name: "wait_seconds", args: {} }] },
    { id: 3, kind: "tool", toolCallId: "a", name: "todo", text: "已保存" },
  ];
  const running = toolActivities(entries, [{ name: "wait_seconds", callId: "b", status: "running" }], true);
  assert.equal(running.length, 2);
  assert.deepEqual(running.map(item => item.status), ["completed", "running"]);
  assert.deepEqual(toolActivities(entries, [], false).map(item => item.status), ["completed", "interrupted"]);
  assert.equal(toolActivities(entries, [{ name: "wait_seconds", callId: "b", status: "pending" }], true)[1].status, "pending");
  assert.equal(toolActivities(entries, [{ name: "wait_seconds", callId: "b", status: "done" }], true)[1].status, "ended");
});

test("待办清单默认折叠，保留完整内容与更新动作", async t => {
  const prompts: string[] = [];
  const { dom } = await mount(t, <Card card={{ key: "notes:todo", group: "notes", title: "待办清单", text: "✓ 查资料\n○ 整理结论", meta: "已完成 1 / 2 项", actions: [{ kind: "prompt", label: "更新待办", text: "更新清单" }] }} pending={false} onAction={action => { if (action.kind === "prompt") prompts.push(action.text); }} />);
  const details = dom.window.document.querySelector("details")!;
  assert.equal(details.open, false);
  assert.match(details.querySelector("summary")!.textContent!, /已完成 1 \/ 2 项/);
  assert.match(details.querySelector(".note-content")!.textContent!, /查资料.*整理结论/s);
  await act(async () => { details.open = true; (details.querySelector("button") as HTMLButtonElement).click(); });
  assert.deepEqual(prompts, ["更新清单"]);
});

test("重复发送、中文输入和新草稿受到保护，附件发送后只移除原附件", async t => {
  let setDraft!: (value: string) => void;
  let connected!: (id: number) => void;
  const connection = new Promise<number>(resolve => { connected = resolve; });
  const calls: { path: string; body: unknown }[] = [];
  t.mock.method(apiClient, "request", async (path: string, body?: unknown) => { calls.push({ path, body }); return { submissionId: 1 }; });
  function Harness() {
    const [draft, changeDraft] = useState("今天做什么"); setDraft = changeDraft;
    return <Composer draft={draft} setDraft={changeDraft} view={null} connect={() => connection} onSent={() => {}} onNewConversation={async () => {}} />;
  }
  const { dom } = await mount(t, <Harness />);
  const input = dom.window.document.querySelector<HTMLInputElement>('input[type="file"]')!;
  async function upload(name: string) {
    Object.defineProperty(input, "files", { configurable: true, value: [new File(["text"], name, { type: "text/plain" })] });
    await act(async () => { input.dispatchEvent(new dom.window.Event("change", { bubbles: true })); });
  }
  await upload("first.txt");
  const textarea = dom.window.document.querySelector("textarea")!;
  await act(async () => { textarea.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Enter", isComposing: true, bubbles: true })); });
  assert.equal(calls.length, 0);
  await act(async () => { textarea.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Enter", shiftKey: true, bubbles: true })); });
  assert.equal(calls.length, 0);
  const send = dom.window.document.getElementById("btn-send") as HTMLButtonElement;
  await act(async () => { send.click(); send.click(); });
  assert.equal(send.getAttribute("aria-busy"), "true");
  assert.equal(calls.length, 0);
  await act(async () => setDraft("又想到另一件事"));
  await upload("next.txt");
  await act(async () => { connected(7); });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].path, "/api/conversations/7/messages");
  const body = calls[0].body as { text: string; mode: string; attachments: { name: string }[] };
  assert.equal(body.text, "今天做什么"); assert.equal(body.mode, "steer");
  assert.deepEqual(body.attachments.map(file => file.name), ["first.txt"]);
  assert.equal(textarea.value, "又想到另一件事");
  assert.doesNotMatch(dom.window.document.querySelector(".attachments-preview")!.textContent!, /first.txt/);
  assert.match(dom.window.document.querySelector(".attachments-preview")!.textContent!, /next.txt/);
});

test("发送未确认保留草稿，重试相同消息使用同一 requestId", async t => {
  const ids: string[] = [];
  let failed = true;
  t.mock.method(apiClient, "request", async (_path: string, body: { requestId: string }) => {
    ids.push(body.requestId); if (failed) throw new Error("连接中断"); return { submissionId: 1 };
  });
  function Harness() {
    const [draft, setDraft] = useState("记住这个约定");
    return <Composer draft={draft} setDraft={setDraft} view={null} connect={async () => 7} onSent={() => {}} onNewConversation={async () => {}} />;
  }
  const { dom } = await mount(t, <Harness />);
  await act(async () => { (dom.window.document.getElementById("btn-send") as HTMLButtonElement).click(); });
  assert.equal(dom.window.document.querySelector("textarea")!.value, "记住这个约定");
  failed = false;
  await act(async () => { (dom.window.document.getElementById("btn-send") as HTMLButtonElement).click(); });
  assert.equal(ids.length, 2); assert.equal(ids[0], ids[1]);
  assert.equal(dom.window.document.querySelector("textarea")!.value, "");
});

test("菜单直接展示个人数据，切换分类不显示对话且不发送消息", async t => {
  t.mock.method(apiClient, "connect", async () => {});
  const writes: string[] = [];
  t.mock.method(apiClient, "request", async (path: string, body?: unknown) => {
    if (body !== undefined) writes.push(path);
    return path === "/api/personal" ? {
      memory: [{ id: "preference", text: "每周五整理项目", status: "approved" }],
      skills: [{ id: "review", name: "项目复盘", description: "核对完成情况", body: "逐项核对交付", status: "approved" }],
      knowledge: { enabled: false, allow: [] },
    } : { schedules: [], reminders: [], background: [] };
  });
  const { dom } = await mount(t, <App />);
  const document = dom.window.document;
  for (const [label, text, excluded] of [["长期记忆", "每周五整理项目", "项目复盘"], ["本机技能", "这台电脑的技能", "每周五整理项目"]]) {
    await act(async () => { document.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)!.click(); });
    assert.equal(document.getElementById("workspace")!.dataset.view, "data");
    assert.equal(document.querySelector(".data-panel h1")!.textContent, label);
    const visiblePage = [...document.querySelectorAll<HTMLElement>(".workspace-content-page")].find(element => !element.parentElement!.hidden)!;
    assert.match(visiblePage.textContent!, new RegExp(text));
    assert.equal(visiblePage.querySelector(".markdown-editor"), null);
    assert.doesNotMatch(visiblePage.textContent!, new RegExp(excluded));
    assert.equal(document.getElementById("message-history"), null);
    assert.equal(document.querySelector(`[aria-label="${label}"]`)!.getAttribute("aria-current"), "page");
  }
  assert.deepEqual(writes, []);
  await act(async () => { document.querySelector<HTMLButtonElement>('[aria-label="继续对话"]')!.click(); });
  assert.ok(document.getElementById("message-history"));
  assert.equal(document.querySelector(".data-panel"), null);
  await act(async () => { document.querySelector<HTMLButtonElement>('[aria-label="首页"]')!.click(); });
    await act(async () => { document.querySelector<HTMLButtonElement>(".today-shortcut")!.click(); });
  assert.match(document.querySelector<HTMLTextAreaElement>("#chat-textarea")!.value, /Daylight 待办/);
  assert.equal(document.getElementById("workspace")!.dataset.view, "chat");
});

test("状态浮层在外部点击、焦点移出、Escape 和切换页面时关闭，内部操作不误关", async t => {
  t.mock.method(apiClient, "connect", async () => {});
  t.mock.method(apiClient, "request", async (path: string) => path === "/api/personal" ? { memory: [], skills: [], knowledge: { enabled: false, allow: [] } } : { schedules: [], reminders: [], background: [] });
  const { dom, render } = await mount(t, <App />);
  const document = dom.window.document;
  const service = document.querySelector<HTMLDetailsElement>(".service-menu")!;
  const summary = service.querySelector("summary")!;
  async function open() { await act(async () => { summary.click(); }); assert.equal(service.open, true); }
  await open();
  await act(async () => { service.querySelector(".service-popover")!.dispatchEvent(new dom.window.Event("pointerdown", { bubbles: true })); });
  assert.equal(service.open, true);
  await act(async () => { document.getElementById("message-history")!.dispatchEvent(new dom.window.Event("pointerdown", { bubbles: true })); });
  assert.equal(service.open, false);
  await render(<App />); assert.equal(service.open, false);
  await open();
  await act(async () => { document.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
  assert.equal(service.open, false); assert.equal(document.activeElement, summary);
  await open();
  await act(async () => { document.querySelector<HTMLAnchorElement>('[aria-label="首页"]')!.focus(); });
  assert.equal(service.open, false);
  await open();
  await act(async () => { document.querySelector<HTMLButtonElement>('[aria-label="继续对话"]')!.click(); });
  assert.equal(service.open, false);
});

test("React 卡片忽略旧会话回包，操作绑定原会话且重复点击只提交一次", async t => {
  const requests: { path: string; resolve: (value: unknown) => void; reject: (error: Error) => void }[] = [];
  t.mock.method(apiClient, "request", (path: string) => new Promise((resolve, reject) => requests.push({ path, resolve, reject })));
  const personal = { memory: [], skills: [], knowledge: { enabled: false, allow: [] } };
  function management(text: string): Management {
    return { schedules: [{ id: "plan", text, status: "active", nextAt: 10000, everyMinutes: 30, runs: 0, lastRunAt: null, createdAt: 1, revision: 1 }], reminders: [], background: [] };
  }
  const view = (id: number) => ({ conversationId: id, entries: [{ id: 1, kind: "user", text: "安排提醒" }, { id: 2, kind: "assistant", text: "", toolCalls: [{ id: "s", name: "schedule_task", args: {} }] }], notes: { todos: [], memos: [] }, live: {}, busy: false, inbox: 0, usage: null, tasks: [], reminders: [], subagents: [], parentId: null }) satisfies ConversationView;
  const panel = (id: number) => <CardPanel view={view(id)} onPrompt={() => {}} />;
  const { dom, render } = await mount(t, panel(8));
  assert.equal(requests.length, 2);
  await render(panel(9)); assert.equal(requests.length, 4);
  await act(async () => { requests[2].resolve(management("新会话提醒")); requests[3].resolve(personal); });
  await act(async () => { requests[0].resolve(management("旧会话提醒")); requests[1].resolve(personal); });
  assert.match(dom.window.document.body.textContent!, /新会话提醒/);
  assert.doesNotMatch(dom.window.document.body.textContent!, /旧会话提醒/);
  const button = dom.window.document.querySelector<HTMLButtonElement>('[data-card-key="schedule:plan"] button')!;
  await act(async () => { button.click(); button.click(); });
  assert.equal(requests.length, 5); assert.equal(requests[4].path, "/api/conversations/9/schedules/plan/pause");
  await render(panel(10));
  await act(async () => { requests[4].resolve({}); });
  assert.equal(dom.window.document.getElementById("card-feedback")!.textContent, "");
  await act(async () => { requests[5].resolve(management("另一个会话")); requests[6].resolve(personal); });
  const next = dom.window.document.querySelector<HTMLButtonElement>('[data-card-key="schedule:plan"] button')!;
  await act(async () => { next.click(); });
  await act(async () => { requests[7].reject(new Error("断线")); });
  assert.match(dom.window.document.getElementById("card-feedback")!.textContent!, /操作未能确认/);
  assert.doesNotMatch(dom.window.document.getElementById("card-feedback")!.textContent!, /操作已完成/);
  await act(async () => { requests[8].resolve(management("另一个会话")); requests[9].resolve(personal); });
});
