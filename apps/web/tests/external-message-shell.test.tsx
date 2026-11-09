import test from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { act, useState } from "react";
import type { ConversationView } from "@assistant/contracts";
import { ExternalConversationPanel } from "../dist/ui/ExternalConversationPanel.js";
import { App } from "../dist/ui/App.js";
import { apiClient } from "../dist/api/socket.js";
import { mount } from "./dom.js";

test("外部消息面板展开、收起和隐藏都不重建当前内容或更改路由", async t => {
  let mounts = 0;
  function Content() { const [value, setValue] = useState(() => { mounts++; return 0; }); return <button id="content-state" onClick={() => setValue(previous => previous + 1)}>{value}</button>; }
  const render = (active = true, compact = true) => <ExternalConversationPanel active={active} compact={compact} id="test-messages" label="Teams"><Content /></ExternalConversationPanel>;
  const view = await mount(t, render()), doc = view.dom.window.document;
  const stage = doc.querySelector<HTMLElement>(".external-message-stage")!;
  const resize = doc.querySelector<HTMLButtonElement>(".external-message-resize")!;
  const content = doc.querySelector<HTMLButtonElement>("#content-state")!;
  const hash = view.dom.window.location.hash;
  assert.equal(stage.dataset.expanded, "false");
  assert.equal(resize.getAttribute("aria-controls"), "test-messages");
  assert.equal(resize.getAttribute("aria-label"), "展开消息面板");
  await act(async () => { content.click(); resize.focus(); resize.click(); });
  assert.equal(stage.dataset.expanded, "true");
  assert.equal(resize.getAttribute("aria-expanded"), "true");
  assert.equal(resize.getAttribute("aria-label"), "收起消息面板");
  assert.equal(doc.activeElement, resize);
  assert.equal(doc.querySelector("#content-state"), content);
  assert.equal(content.textContent, "1");
  await view.render(render(false));
  assert.equal(stage.hidden, true);
  await view.render(render(true));
  assert.equal(stage.dataset.expanded, "true");
  await act(async () => { resize.click(); });
  assert.equal(stage.dataset.expanded, "false");
  await view.render(render(true, false));
  assert.equal(doc.querySelector(".external-message-stage"), null, "内部对话不套用外部消息布局");
  assert.equal(doc.querySelector<HTMLElement>(".external-message-toolbar")?.hidden, true);
  assert.equal(doc.querySelector("#content-state"), content, "来源元数据改变不能清除草稿或附件的本地状态");
  assert.equal(mounts, 1);
  assert.equal(view.dom.window.location.hash, hash);
});

async function harness(t: TestContext, entries?: ConversationView["entries"]) {
  t.mock.method(apiClient, "connect", async () => {});
  t.mock.method(apiClient, "onConnection", () => () => {});
  let receive!: (view: ConversationView) => void;
  t.mock.method(apiClient, "onView", (callback: (view: ConversationView) => void) => { receive = callback; return () => {}; });
  let pending = false;
  const subscriptions: number[] = [], writes: string[] = [];
  function sendView(id: number, channel: string) { receive({ conversationId: id, channel, entries: entries ?? [{ id: 1, kind: "user", text: "原有对话" }], live: {}, busy: false, inbox: 0, notes: { todos: [], memos: [] }, usage: null, tasks: [], reminders: [], subagents: [], parentId: null }); }
  t.mock.method(apiClient, "subscribeConversation", async (id: number) => { subscriptions.push(id); if (!pending) sendView(id, id === 12 ? "wechat" : "web"); });
  t.mock.method(apiClient, "request", async (path: string, body?: unknown) => {
    if (body !== undefined && path !== "/api/mail/delivery") writes.push(path);
    if (path === "/api/conversations") return [{ id: 12, title: "微信里的安排", channel: "wechat", createdAt: "2026-11-06", archivedAt: null }, { id: 19, title: "网页里的计划", channel: "wechat", createdAt: "2026-11-06", archivedAt: null }];
    if (path === "/api/teams/conversations") return { available: true, items: [], nextCursor: null, fetchedAt: "2026-11-06T10:00:00Z" };
    if (path.startsWith("/api/teams/conversations/messages?")) return { chatId: new URL(path, "http://localhost").searchParams.get("chatId"), items: [], nextCursor: null, fetchedAt: "2026-11-06T10:00:00Z" };
    if (path === "/api/personal") return { memory: [], skills: [], knowledge: { enabled: false, allow: [] } };
    return { items: [], total: 0, schedules: [], reminders: [], background: [] };
  });
  const mounted = await mount(t, null), doc = mounted.dom.window.document;
  return { ...mounted, doc, subscriptions, writes, defer: () => { pending = true; },
    receive: async (id: number, channel: string) => { await act(async () => sendView(id, channel)); },
    restore: async (hash: string) => { await act(async () => { mounted.dom.window.history.replaceState(null, "", hash); mounted.dom.window.dispatchEvent(new mounted.dom.window.PopStateEvent("popstate")); }); },
  };
}

test("微信与普通 Dee 使用相同完整对话布局，保留来源提示、输入框和独立 Teams 阅读器", async t => {
  const view = await harness(t);
  view.dom.window.history.replaceState(null, "", "#chat/19");
  await view.render(<App />);
  const input = view.doc.querySelector<HTMLTextAreaElement>("#chat-textarea")!;
  assert.equal(view.doc.querySelector(".external-message-stage:not([hidden])"), null, "不能以历史列表的过期来源标签推断当前发送身份");
  assert.equal(view.doc.querySelector(".conversation-title")?.textContent, "网页里的计划");
  await view.restore("#chat/12");
  const wechatFrame = view.doc.querySelector(".conversation-surface-panel")!;
  assert.equal(wechatFrame.id, "assistant-conversation-panel");
  assert.equal(view.doc.querySelector(".external-message-stage:not([hidden])"), null);
  assert.equal(view.doc.querySelector<HTMLElement>(".app-layout")?.dataset.externalConversation, "false");
  assert.equal(view.doc.querySelector(".conversation-title")?.textContent, "微信里的安排");
  assert.match(view.doc.querySelector(".conversation-channel-label")?.textContent ?? "", /微信里的 Dee/);
  assert.ok(wechatFrame.contains(view.doc.querySelector(".wechat-conversation-notice")));
  assert.equal(view.doc.querySelector("#chat-textarea"), input);
  assert.equal(view.dom.window.location.hash, "#chat/12");
  await view.restore("#teams/19%3Aexample%40thread.v2");
  const teamsFrame = view.doc.querySelector(".external-message-stage:not([hidden]) .external-message-panel")!;
  assert.equal(teamsFrame.id, "teams-external-message-panel");
  assert.equal(view.doc.querySelector<HTMLElement>(".input-container")?.hidden, true);
  assert.equal(view.doc.querySelector(".app-layout > .sidebar")?.hasAttribute("inert"), false);
  await view.restore("#chat/12");
  assert.equal(view.doc.querySelector(".conversation-surface-panel"), wechatFrame);
  assert.equal(view.doc.querySelector(".external-message-stage:not([hidden])"), null);
  assert.equal(view.doc.querySelector("#chat-textarea"), input);
  await view.restore("#chat/19");
  assert.equal(view.doc.querySelector(".external-message-stage:not([hidden])"), null);
  assert.equal(view.doc.querySelector(".conversation-channel-label"), null);
  assert.deepEqual(view.subscriptions, [19, 12, 19]);
  assert.deepEqual(view.writes, []);
});

test("内嵌 IM 引用仅进入当前会话草稿，切换与取消不串会话，也不发送消息", async t => {
  const record = { chatId: "source-chat", id: "one", chatLabel: "原始聊天", sender: "甲", createdAt: "2026-11-09T13:24:06Z", text: "原始 FTP 申请", media: [] };
  const view = await harness(t, [{ id: 1, kind: "user", text: "查看聊天" }, { id: 2, kind: "tool", name: "teams_history", text: `<teams-records>${JSON.stringify([record])}</teams-records>` }, { id: 3, kind: "assistant", text: "读取完成" }]);
  view.dom.window.history.replaceState(null, "", "#chat/19");
  await view.render(<App />);
  const input = view.doc.querySelector<HTMLTextAreaElement>("#chat-textarea")!;
  assert.ok(view.doc.querySelector(".assistant-turn .teams-records-chat .teams-records-scroll"));
  await act(async () => view.doc.querySelector<HTMLButtonElement>(".teams-record-quote")!.click());
  assert.match(view.doc.querySelector(".composer-quote")!.textContent!, /原始 FTP 申请/);
  assert.equal(input.value, "");
  await view.restore("#chat/12");
  assert.equal(view.doc.querySelector(".composer-quote"), null);
  await act(async () => view.doc.querySelector<HTMLButtonElement>(".teams-record-quote")!.click());
  await act(async () => view.doc.querySelector<HTMLButtonElement>('[aria-label="取消引用"]')!.click());
  assert.equal(view.doc.querySelector(".composer-quote"), null);
  await view.restore("#chat/19");
  assert.match(view.doc.querySelector(".composer-quote")!.textContent!, /原始 FTP 申请/);
  view.defer();
  await view.restore("#chat/12");
  assert.equal(view.doc.querySelector(".composer-quote"), null);
  assert.equal(view.doc.querySelector(".teams-record-quote"), null, "来源未加载不能引用旧会话记录");
  assert.equal(view.doc.querySelector<HTMLButtonElement>(".btn-send")!.disabled, true);
  assert.deepEqual(view.writes, []);
});

test("切换尚未加载的会话时不能保留旧微信身份或发送权限", async t => {
  const view = await harness(t);
  view.dom.window.history.replaceState(null, "", "#chat/12");
  await view.render(<App />);
  view.defer();
  await view.restore("#chat/19");
  assert.equal(view.doc.querySelector(".external-message-stage:not([hidden])"), null);
  assert.equal(view.doc.querySelector(".conversation-channel-label"), null);
  assert.ok(view.doc.querySelector(".conversation-source-pending"));
  assert.equal(view.doc.querySelector<HTMLButtonElement>(".btn-send")?.disabled, true);
  await view.receive(19, "web");
  assert.equal(view.doc.querySelector(".conversation-source-pending"), null);
  assert.equal(view.doc.querySelector(".external-message-stage:not([hidden])"), null);
  assert.deepEqual(view.writes, []);
});

test("消息外框使用 480px 默认宽度、可扩展宽度和不溢出的窄屏布局", async () => {
  const css = await readFile(new URL("../public/workspace.css", import.meta.url), "utf8");
  assert.match(css, /\.external-message-shell \{[^}]*width: 480px;[^}]*max-width: 100%;/);
  assert.match(css, /data-expanded="true"\] \.external-message-shell \{ width: 1120px;/);
  assert.match(css, /--external-panel-surface: #fff;/);
  assert.match(css, /\.app-layout > \.sidebar \{[^}]*background: var\(--menu-surface, #fff\)/);
  assert.match(css, /\.conversation-history \{[^}]*background: var\(--menu-surface, #fff\)/);
  assert.match(css, /@media \(max-width: 600px\)/);
  assert.match(css, /\.external-message-toolbar \{ display: none; \}/);
  assert.match(css, /\.conversation-surface, \.conversation-surface-shell, \.conversation-surface-panel \{ display: contents; \}/);
});
