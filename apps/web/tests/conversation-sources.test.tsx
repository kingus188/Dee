import test from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { act } from "react";
import type { ConversationView } from "@assistant/contracts";
import { App } from "../dist/ui/App.js";
import { ConversationSource } from "../dist/ui/ConversationSource.js";
import { WorkspaceNavigation } from "../dist/ui/WorkspaceNavigation.js";
import { apiClient } from "../dist/api/socket.js";
import { mount } from "./dom.js";

async function harness(t: TestContext) {
  t.mock.method(apiClient, "connect", async () => {});
  let receive!: (view: ConversationView) => void;
  t.mock.method(apiClient, "onView", (callback: (view: ConversationView) => void) => { receive = callback; return () => {}; });
  const subscriptions: number[] = [];
  t.mock.method(apiClient, "subscribeConversation", async (id: number) => {
    subscriptions.push(id);
    receive({ conversationId: id, entries: [{ id: 1, kind: "user", text: `讨论 ${id}` }, { id: 2, kind: "assistant", text: "已收到。" }], live: {}, busy: false, inbox: 0, notes: { todos: [], memos: [] }, usage: null, tasks: [], reminders: [], subagents: [], parentId: null });
  });
  const calls: string[] = [];
  t.mock.method(apiClient, "request", async (path: string) => {
    calls.push(path);
    if (path === "/api/conversations") return [{ id: 12, title: "产品方案跟进", channel: "web", createdAt: "2026-10-21", archivedAt: null }, { id: 19, title: "季度计划", channel: "web", createdAt: "2026-10-22", archivedAt: null }];
    if (path.startsWith("/api/teams/conversations/messages?")) return { chatId: new URL(path, "http://localhost").searchParams.get("chatId"), items: [], nextCursor: null, fetchedAt: "2026-11-06T10:00:00Z" };
    if (path === "/api/teams/conversations") return { available: true, items: [], nextCursor: null, fetchedAt: "2026-11-06T10:00:00Z" };
    if (path === "/api/personal") return { memory: [], skills: [], knowledge: { enabled: false, allow: [] } };
    return { items: [], total: 0, schedules: [], reminders: [], background: [] };
  });
  const mounted = await mount(t, null);
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "requestAnimationFrame");
  const frames: FrameRequestCallback[] = [];
  Object.defineProperty(globalThis, "requestAnimationFrame", { configurable: true, value: (callback: FrameRequestCallback) => frames.push(callback) });
  t.after(() => { if (descriptor) Object.defineProperty(globalThis, "requestAnimationFrame", descriptor); else Reflect.deleteProperty(globalThis, "requestAnimationFrame"); });
  const doc = mounted.dom.window.document;
  return { ...mounted, doc, calls, subscriptions,
    flushFrames: async () => { await act(async () => { for (const callback of frames.splice(0)) callback(0); }); },
    restore: async (hash: string) => { await act(async () => { mounted.dom.window.history.replaceState(null, "", hash); mounted.dom.window.dispatchEvent(new mounted.dom.window.PopStateEvent("popstate")); }); },
  };
}

test("来源切换器保持原生键盘选择语义，Teams 使用现有对话导航", async t => {
  const sources: string[] = [];
  const { dom } = await mount(t, <><ConversationSource source="assistant" onAssistant={() => sources.push("assistant")} onTeams={() => sources.push("teams")} /><WorkspaceNavigation route={{ page: "teams", group: null, chatId: "19:chat" }} onNavigate={() => {}} onHelp={() => {}} /></>);
  const doc = dom.window.document, select = doc.querySelector("select")!;
  assert.equal(select.getAttribute("aria-label"), "切换对话来源");
  assert.deepEqual([...select.options].map(option => option.value), ["assistant", "teams"]);
  await act(async () => { select.value = "teams"; select.dispatchEvent(new dom.window.Event("change", { bubbles: true })); });
  assert.deepEqual(sources, ["teams"]);
  assert.equal(doc.querySelectorAll(".workspace-primary-nav > a").length, 3);
  assert.equal(doc.querySelector('[aria-current="page"]')?.getAttribute("aria-label"), "继续对话");
  assert.equal(doc.querySelector<HTMLElement>(".workspace-more-button")!.dataset.active, "false");
});

test("历史会话标题来自真实记录，折叠侧栏及前进后退仍保持对应标题", async t => {
  const view = await harness(t);
  view.dom.window.localStorage.setItem("dee.history.collapsed", "true");
  view.dom.window.history.replaceState(null, "", "#chat/12");
  await view.render(<App />);
  assert.equal(view.doc.querySelector(".conversation-title")?.textContent, "产品方案跟进");
  assert.equal(view.doc.querySelector<HTMLElement>("#conversation-history")?.hidden, true);
  assert.equal(view.doc.querySelector(".conversation-toolbar"), null, "有消息的会话使用独立页头，不能覆盖消息");
  assert.equal(view.doc.querySelector(".conversation-header")?.nextElementSibling?.id, "messages-container");
  await view.restore("#chat/19");
  assert.equal(view.doc.querySelector(".conversation-title")?.textContent, "季度计划");
  await view.restore("#chat/12");
  assert.equal(view.doc.querySelector(".conversation-title")?.textContent, "产品方案跟进");
  assert.deepEqual(view.subscriptions, [12, 19, 12]);
});

test("从助手切换 Teams 后隐藏助手输入并恢复来源路由，不订阅 Teams 编号", async t => {
  const view = await harness(t);
  view.dom.window.history.replaceState(null, "", "#chat/12");
  await view.render(<App />);
  const select = view.doc.querySelector<HTMLSelectElement>(".conversation-history select")!;
  await act(async () => { select.value = "teams"; select.dispatchEvent(new view.dom.window.Event("change", { bubbles: true })); });
  await view.flushFrames();
  assert.equal(view.dom.window.location.hash, "#teams");
  assert.equal(view.doc.getElementById("workspace")?.dataset.view, "teams");
  assert.equal(view.doc.querySelector<HTMLElement>(".conversation-sidebar")?.hidden, true);
  assert.equal(view.doc.querySelector<HTMLElement>(".input-container")?.hidden, true);
  assert.equal(view.doc.querySelector(".management-header"), null);
  assert.equal(view.doc.activeElement?.id, "workspace");
  await view.restore("#teams/19%3Agroup%40thread.v2");
  assert.equal(view.doc.getElementById("workspace")?.dataset.view, "teams");
  assert.deepEqual(view.subscriptions, [12]);
  await view.restore("#chat/12");
  assert.equal(view.doc.querySelector<HTMLElement>(".input-container")?.hidden, false);
  assert.equal(view.doc.querySelector(".conversation-title")?.textContent, "产品方案跟进");
});

test("移动端来源切换与浏览器返回会关闭模态历史并解除背景隔离", async t => {
  const view = await harness(t);
  Object.defineProperty(view.dom.window, "matchMedia", { configurable: true, value: (media: string) => ({ matches: true, media, addEventListener() {}, removeEventListener() {} }) });
  view.dom.window.history.replaceState(null, "", "#chat/12");
  await view.render(<App />);
  const toggle = view.doc.querySelector<HTMLButtonElement>(".sidebar-toggle")!;
  await act(async () => { toggle.click(); });
  assert.equal(view.doc.getElementById("workspace")?.hasAttribute("inert"), true);
  const select = view.doc.querySelector<HTMLSelectElement>(".conversation-history select")!;
  await act(async () => { select.focus(); select.value = "teams"; select.dispatchEvent(new view.dom.window.Event("change", { bubbles: true })); });
  await view.flushFrames();
  assert.equal(view.doc.getElementById("workspace")?.hasAttribute("inert"), false);
  assert.equal(view.doc.querySelector(".history-backdrop"), null);
  await view.restore("#chat/12");
  await act(async () => { toggle.click(); });
  assert.equal(view.doc.getElementById("workspace")?.hasAttribute("inert"), true);
  await view.restore("#teams");
  await view.restore("#chat/12");
  assert.equal(view.doc.querySelector<HTMLElement>("#conversation-history")?.hidden, true);
  assert.equal(view.doc.getElementById("workspace")?.hasAttribute("inert"), false);
  assert.equal(view.dom.window.localStorage.getItem("dee.history.collapsed"), null);
});

test("反复切换来源保留各自会话，Teams 抽屉同时隔离主导航", async t => {
  const view = await harness(t);
  Object.defineProperty(view.dom.window, "matchMedia", { configurable: true, value: (media: string) => ({ matches: true, media, addEventListener() {}, removeEventListener() {} }) });
  view.dom.window.history.replaceState(null, "", "#chat/12");
  await view.render(<App />);
  const draft = view.doc.querySelector<HTMLTextAreaElement>("#chat-textarea")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(view.dom.window.HTMLTextAreaElement.prototype, "value")!.set!.call(draft, "尚未发送的草稿");
    draft.dispatchEvent(new view.dom.window.Event("input", { bubbles: true }));
  });
  const teamsHash = "#teams/19%3Aproduct%40thread.v2";
  await view.restore(teamsHash);
  const source = view.doc.querySelector<HTMLSelectElement>(".teams-conversation-sidebar select")!;
  assert.ok(source);
  const rail = view.doc.querySelector<HTMLElement>(".app-layout > .sidebar")!;
  const toggle = view.doc.querySelector<HTMLButtonElement>(".teams-mobile-toggle")!;
  await act(async () => { toggle.click(); });
  assert.equal(rail.hasAttribute("inert"), true);
  await act(async () => { view.doc.dispatchEvent(new view.dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
  assert.equal(rail.hasAttribute("inert"), false);
  await act(async () => { source.value = "assistant"; source.dispatchEvent(new view.dom.window.Event("change", { bubbles: true })); });
  await view.flushFrames();
  assert.equal(view.dom.window.location.hash, "#chat/12");
  assert.equal(view.doc.querySelector(".conversation-title")?.textContent, "产品方案跟进");
  assert.equal(draft.value, "尚未发送的草稿");
  const assistantSource = view.doc.querySelector<HTMLSelectElement>(".conversation-history select")!;
  await act(async () => { assistantSource.value = "teams"; assistantSource.dispatchEvent(new view.dom.window.Event("change", { bubbles: true })); });
  await view.flushFrames();
  assert.equal(view.dom.window.location.hash, teamsHash);
  assert.equal(view.doc.querySelector<HTMLSelectElement>(".teams-conversation-sidebar select")?.value, "teams");
  assert.deepEqual(view.subscriptions, [12]);
});
