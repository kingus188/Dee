import test from "node:test";
import assert from "node:assert/strict";
import { act, useState } from "react";
import type { TeamsConversationList, TeamsConversationMessage, TeamsConversationMessages, TeamsTriageItem } from "@assistant/contracts";
import { TeamsConversations } from "../dist/teams/TeamsConversations.js";
import { isTeamsConversationList, isTeamsConversationMessages, mergeTeamsMessages } from "../dist/teams/conversation-data.js";
import { apiClient } from "../dist/api/socket.js";
import { mount } from "./dom.js";

const at = "2026-11-06T09:00:00Z", noop = () => {};
const chats = (): TeamsConversationList => ({ available: true, canSend: true, items: [{ id: "chat", title: "产品协作", kind: "group", sourceUrl: "https://teams.microsoft.com/l/chat/chat" }, { id: "other", title: "另一会话", kind: "oneOnOne" }], fetchedAt: at, nextCursor: null });
const message = (id: string, patch: Partial<TeamsConversationMessage> = {}): TeamsConversationMessage => ({ id, chatId: "chat", senderName: "陈雨", direction: "in", createdAt: at, text: "请确认交付时间。", deleted: false, unavailable: false, media: [], ...patch });
const suggestion = (): TeamsTriageItem => ({ id: "chat:in", chatId: "chat", chatLabel: "产品协作", senderName: "陈雨", createdAt: at, text: "请确认交付时间。", revision: 4, attention: "later", reason: "消息包含面向你的行动请求。", uncertainty: "尚未核对完整上下文。", suggestTodo: true, suggestedTitle: "确认交付时间" });
const page = (items: TeamsConversationMessage[], nextCursor: string | null = null, chatId = "chat"): TeamsConversationMessages => ({ chatId, items, nextCursor, fetchedAt: at });
const props = { active: true, chatId: "chat", onSelectChat: noop, onAssistant: noop, onDaylight: noop, onSettings: noop };
function button(doc: Document, text: string) { const found = [...doc.querySelectorAll<HTMLButtonElement>("button")].find(item => item.textContent?.trim() === text); assert.ok(found, text); return found; }

test("Teams browser renders real speakers, date groups, sources and a reply composer without automatic writes", async t => {
  const requests: { path: string; body: unknown }[] = [];
  t.mock.method(apiClient, "request", async (path: string, body?: unknown) => { requests.push({ path, body }); return path === "/api/teams/conversations" ? chats() : page([message("in"), message("out", { direction: "out", senderName: "本人", createdAt: "2026-11-06T10:00:00Z" })]); });
  const view = await mount(t, <TeamsConversations {...props} />), doc = view.dom.window.document;
  assert.equal(doc.querySelectorAll(".teams-conversation-choice").length, 2);
  assert.equal(doc.querySelector(".teams-conversation-header h1")!.textContent, "产品协作");
  assert.equal(doc.querySelectorAll(".teams-date-divider").length, 1);
  assert.match(doc.querySelector('[data-direction="in"]')!.textContent!, /陈雨/);
  assert.match(doc.querySelector('[data-direction="out"]')!.textContent!, /我/);
  assert.equal(doc.querySelector(".teams-header-source")!.getAttribute("href"), chats().items[0].sourceUrl);
  assert.ok(doc.querySelector("textarea[aria-label='Teams 回复内容']"));
  assert.doesNotMatch(doc.body.textContent!, /未读|发送消息/);
  assert.ok(requests.every(item => item.body === undefined));
});

test("Loading older pages deduplicates and sorts all records chronologically, repeated clicks request only once", async t => {
  let finish!: (data: unknown) => void, pages = 0;
  t.mock.method(apiClient, "request", async (path: string) => {
    if (path === "/api/teams/conversations") return chats();
    pages++;
    return path.includes("cursor=") ? new Promise(resolve => { finish = resolve; }) : page([message("new", { createdAt: "2026-11-06T10:00:00Z" })], "opaque-next");
  });
  const view = await mount(t, <TeamsConversations {...props} />), doc = view.dom.window.document;
  await act(async () => { button(doc, "加载更早消息").click(); button(doc, "加载更早消息").click(); });
  assert.equal(pages, 2);
  await act(async () => { finish(page([message("old", { createdAt: "2026-11-05T09:00:00Z" }), message("new", { createdAt: "2026-11-06T10:00:00Z" })])); });
  assert.deepEqual([...doc.querySelectorAll("[data-message-id]")].map(item => item.getAttribute("data-message-id")), ["old", "new"]);
  assert.equal(doc.querySelectorAll(".teams-date-divider").length, 2);
  assert.match(doc.body.textContent!, /2 条已加载/);
  assert.doesNotMatch(doc.body.textContent!, /还有更早消息/);
});

test("Task suggestion requires review and explicit confirmation, double clicks cannot create twice", async t => {
  const writes: unknown[] = [], opened: string[] = []; let finish!: (data: unknown) => void;
  t.mock.method(apiClient, "request", async (path: string, body?: unknown) => {
    if (body) { writes.push(body); return new Promise(resolve => { finish = resolve; }); }
    return path === "/api/teams/conversations" ? chats() : page([message("in", { suggestion: suggestion() })]);
  });
  const view = await mount(t, <TeamsConversations {...props} onDaylight={id => { if (id) opened.push(id); }} />), doc = view.dom.window.document;
  await act(async () => { button(doc, "创建待办").click(); });
  assert.deepEqual(writes, []); assert.ok(doc.querySelector(".teams-todo-confirm"));
  await act(async () => { button(doc, "取消").click(); });
  assert.equal(doc.querySelector(".teams-todo-confirm"), null); assert.deepEqual(writes, []);
  await act(async () => { button(doc, "创建待办").click(); });
  await act(async () => { button(doc, "确认创建待办").click(); button(doc, "确认创建待办").click(); });
  assert.deepEqual(writes, [{ id: "chat:in", revision: 4, action: "create" }]);
  await act(async () => { finish({ ok: true, taskId: "task-real" }); });
  assert.equal(doc.querySelector(".teams-message-suggestion"), null);
  assert.match(doc.querySelector('[role="status"]')!.textContent!, /待办已创建/);
  await act(async () => { button(doc, "查看待办").click(); });
  assert.deepEqual(opened, ["task-real"]);
});

test("Switching chats or leaving discards old text and late pages or actions", async t => {
  let finish!: (data: unknown) => void;
  t.mock.method(apiClient, "request", async (path: string) => {
    if (path === "/api/teams/conversations") return chats();
    if (path.includes("chatId=chat")) return new Promise(resolve => { finish = resolve; });
    return page([message("other", { chatId: "other", text: "新会话正文" })], null, "other");
  });
  const view = await mount(t, <TeamsConversations {...props} />), doc = view.dom.window.document;
  await view.render(<TeamsConversations {...props} chatId="other" />);
  await act(async () => { finish(page([message("old", { text: "不能覆盖新会话的旧正文" })])); });
  assert.match(doc.body.textContent!, /新会话正文/); assert.doesNotMatch(doc.body.textContent!, /不能覆盖新会话/);
  await view.render(<TeamsConversations {...props} active={false} chatId="other" />);
  assert.equal(doc.querySelectorAll("[data-message-id]").length, 0);
});

test("A failed permission recheck hides previously shown messages and suggestions, never shows an empty success", async t => {
  let reads = 0;
  t.mock.method(apiClient, "request", async (path: string) => {
    if (path === "/api/teams/conversations") return chats();
    if (++reads > 1) throw new Error("Teams 读取被拒绝：权限已撤销");
    return page([message("in", { text: "此前敏感原文", suggestion: suggestion() })]);
  });
  const view = await mount(t, <TeamsConversations {...props} />), doc = view.dom.window.document;
  assert.match(doc.body.textContent!, /此前敏感原文/);
  await act(async () => { button(doc, "刷新消息").click(); });
  assert.doesNotMatch(doc.body.textContent!, /此前敏感原文|当前可读取范围内没有消息/);
  assert.equal(doc.querySelector(".teams-message-suggestion"), null);
  assert.match(doc.querySelector('[role="alert"]')!.textContent!, /权限已撤销/);
});

test("Unsafe markup and links remain inert, tombstones hide content and malformed replies fail closed", async t => {
  let malformed = false;
  t.mock.method(apiClient, "request", async (path: string) => path === "/api/teams/conversations" ? chats() : malformed ? {} : page([
    message("literal", { text: '<script>steal()</script><img src=x>', sourceUrl: "javascript:steal()" }),
    message("deleted", { deleted: true, text: "已撤回正文", senderName: "隐私姓名", sourceUrl: "https://teams.microsoft.com/message", suggestion: undefined }),
  ]));
  const view = await mount(t, <TeamsConversations {...props} />), doc = view.dom.window.document;
  assert.equal(doc.querySelector("script, .teams-message img, .teams-message a"), null);
  assert.match(doc.body.textContent!, /<script>steal/); assert.doesNotMatch(doc.body.textContent!, /已撤回正文|隐私姓名/);
  malformed = true;
  await act(async () => { button(doc, "刷新消息").click(); });
  assert.equal(doc.querySelector(".teams-message"), null);
  assert.match(doc.querySelector('[role="alert"]')!.textContent!, /格式不完整/);
});

test("Contract checks reject cross-chat suggestions, bad dates and missing availability; page merge preserves tombstones", () => {
  assert.equal(isTeamsConversationList(chats()), true); assert.equal(isTeamsConversationList({ items: [], nextCursor: null, fetchedAt: at }), false);
  assert.equal(isTeamsConversationMessages(page([message("in", { suggestion: { ...suggestion(), chatId: "other" } })])), false);
  assert.equal(isTeamsConversationMessages(page([message("in", { createdAt: "unknown" })])), false);
  assert.equal(mergeTeamsMessages([message("gone", { deleted: true })], [message("gone")])[0].deleted, true);
  assert.equal(mergeTeamsMessages([message("edit", { text: "new", modifiedAt: "2026-11-06T11:00:00Z" })], [message("edit", { text: "old" })])[0].text, "new");
});

test("A source rejection supersedes an in-flight older page and immediately removes old originals", async t => {
  let finishPage!: (data: unknown) => void, failAction!: (error: Error) => void, reads = 0;
  t.mock.method(apiClient, "request", async (path: string, body?: unknown) => {
    if (path === "/api/teams/conversations") return chats();
    if (body) return new Promise((_resolve, reject) => { failAction = reject; });
    if (path.includes("cursor=")) return new Promise(resolve => { finishPage = resolve; });
    reads++;
    return reads === 1 ? page([message("in", { text: "已撤回敏感正文", suggestion: suggestion() })], "old-page") : page([]);
  });
  const view = await mount(t, <TeamsConversations {...props} />), doc = view.dom.window.document;
  await act(async () => { button(doc, "加载更早消息").click(); });
  await act(async () => { button(doc, "创建待办").click(); });
  await act(async () => { button(doc, "确认创建待办").click(); });
  await act(async () => { failAction(new Error("原消息已撤回")); });
  assert.doesNotMatch(doc.body.textContent!, /已撤回敏感正文/);
  await act(async () => { finishPage(page([message("in", { text: "已撤回敏感正文", suggestion: suggestion() })])); });
  assert.doesNotMatch(doc.body.textContent!, /已撤回敏感正文/);
  assert.equal(doc.querySelector(".teams-message-suggestion"), null);
  assert.equal(reads, 2, "the failed action forces a current source read even while pagination was pending");
});


test("A narrow Teams container uses list-to-detail navigation even on a wide desktop, keeping search and scroll", async t => {
  const reads: string[] = [];
  t.mock.method(apiClient, "request", async (path: string) => { reads.push(path); return path === "/api/teams/conversations" ? chats() : page([message("in")]); });
  const view = await mount(t, null), doc = view.dom.window.document;
  let resize!: (width: number) => void;
  Object.defineProperty(view.dom.window, "innerWidth", { value: 1600, configurable: true });
  Object.defineProperty(view.dom.window, "ResizeObserver", { configurable: true, value: class {
    constructor(callback: ResizeObserverCallback) { resize = width => callback([{ contentRect: { width } } as ResizeObserverEntry], this as unknown as ResizeObserver); }
    observe() { resize(480); } disconnect() {}
  } });
  function Reader() {
    const [chatId, selectChat] = useState<string>();
    return <TeamsConversations {...props} chatId={chatId} onSelectChat={selectChat} />;
  }
  await view.render(<Reader />);
  const workspace = doc.querySelector<HTMLElement>(".teams-workspace")!, list = doc.querySelector<HTMLElement>(".teams-conversation-sidebar")!, detail = doc.querySelector<HTMLElement>(".teams-conversation-detail")!;
  assert.equal(workspace.dataset.compact, "true");
  assert.equal(list.hidden, false); assert.equal(detail.hidden, true);
  assert.equal(doc.querySelector('[aria-modal="true"], .teams-list-backdrop'), null);
  const input = list.querySelector<HTMLInputElement>("input")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(view.dom.window.HTMLInputElement.prototype, "value")!.set!.call(input, "产品");
    input.dispatchEvent(new view.dom.window.Event("input", { bubbles: true }));
  });
  list.scrollTop = 140;
  await act(async () => { doc.querySelector<HTMLButtonElement>(".teams-conversation-choice")!.click(); });
  assert.equal(list.hidden, true); assert.equal(detail.hidden, false);
  assert.equal(doc.activeElement, detail.querySelector("h1"));
  const scroll = detail.querySelector<HTMLElement>(".teams-message-scroll")!; scroll.scrollTop = 64;
  await act(async () => { doc.querySelector<HTMLButtonElement>(".teams-mobile-toggle")!.click(); });
  assert.equal(list.hidden, false); assert.equal(detail.hidden, true);
  assert.equal(doc.activeElement, input); assert.equal(input.value, "产品"); assert.equal(list.scrollTop, 140);
  await act(async () => { doc.querySelector<HTMLButtonElement>(".teams-conversation-choice")!.click(); });
  assert.equal(detail.hidden, false); assert.equal(scroll.scrollTop, 64);
  assert.equal(reads.filter(path => path.includes("/messages?")).length, 1, "returning to the same conversation must not remount or refetch its timeline");
  await act(async () => { resize(960); });
  assert.equal(workspace.dataset.compact, "false"); assert.equal(list.hidden, false); assert.equal(detail.hidden, false);
  await act(async () => { input.focus(); resize(480); });
  assert.equal(list.hidden, true); assert.equal(detail.hidden, false);
  assert.equal(doc.activeElement, detail.querySelector("h1"), "narrowing must not strand keyboard focus in the hidden list");
  await act(async () => { doc.querySelector<HTMLButtonElement>(".teams-mobile-toggle")!.click(); resize(960); });
  await act(async () => { button(doc, "刷新消息").focus(); resize(480); });
  assert.equal(list.hidden, false); assert.equal(detail.hidden, true);
  assert.equal(doc.activeElement, input, "narrowing while browsing the list must not strand focus in the hidden thread");
});

test("Compact back, Escape and browser-selected chat changes keep exactly the current screen accessible", async t => {
  t.mock.method(apiClient, "request", async (path: string) => path === "/api/teams/conversations" ? chats() : page([], null, new URL(path, "http://localhost").searchParams.get("chatId")!));
  const listStates: boolean[] = [];
  const view = await mount(t, <TeamsConversations {...props} onListOpenChange={open => listStates.push(open)} />), doc = view.dom.window.document;
  const list = doc.querySelector<HTMLElement>(".teams-conversation-sidebar")!, detail = doc.querySelector<HTMLElement>(".teams-conversation-detail")!;
  await act(async () => { doc.querySelector<HTMLButtonElement>(".teams-mobile-toggle")!.click(); });
  assert.equal(list.hidden, false); assert.equal(detail.hidden, true);
  await act(async () => { doc.dispatchEvent(new view.dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
  assert.equal(list.hidden, true); assert.equal(detail.hidden, false);
  assert.equal(doc.activeElement, detail.querySelector("h1"));
  await act(async () => { doc.querySelector<HTMLButtonElement>(".teams-mobile-toggle")!.click(); });
  await view.render(<TeamsConversations {...props} chatId="other" onListOpenChange={open => listStates.push(open)} />);
  assert.equal(list.hidden, true); assert.equal(detail.hidden, false);
  assert.equal(detail.querySelector("h1")!.textContent, "另一会话");
  assert.ok(listStates.every(open => !open), "full-screen list navigation never marks the app as modal");
  detail.querySelector<HTMLHeadingElement>("h1")!.focus();
  await view.render(<TeamsConversations {...props} chatId={undefined} />);
  assert.equal(list.hidden, false); assert.equal(detail.hidden, true);
  assert.equal(doc.activeElement, list.querySelector("input"));
});

test("Compact threads keep long originals and archived attachments readable without introducing writes", async t => {
  const longText = "详细的 Teams 原文与来源限制。".repeat(100), calls: { path: string; body: unknown }[] = [];
  const imageId = "a".repeat(64), fileId = "b".repeat(64);
  t.mock.method(apiClient, "request", async (path: string, body?: unknown) => {
    calls.push({ path, body });
    return path === "/api/teams/conversations" ? chats() : page([message("long", { text: longText, media: [
      { id: imageId, name: "已归档截图.png", kind: "image", status: "saved", previewUrl: `/api/teams/media/${imageId}` },
      { id: fileId, name: "很长的文件名-".repeat(20) + ".pdf", kind: "file", status: "pending" },
    ] })]);
  });
  const { dom } = await mount(t, <TeamsConversations {...props} />), doc = dom.window.document;
  assert.equal(doc.querySelector(".teams-message-bubble > p")!.textContent, longText);
  assert.equal(doc.querySelector(".msg-image-link")!.getAttribute("href"), `/api/teams/media/${imageId}`);
  assert.equal(doc.querySelector(".msg-image-thumb")!.getAttribute("alt"), "已归档截图.png");
  assert.match(doc.querySelector(".msg-file-card")!.textContent!, /正在保存/);
  assert.ok(doc.querySelector("textarea[aria-label='Teams 回复内容']"));
  assert.ok(calls.every(call => call.body === undefined));
});


test("An interrupted compact open waits until the thread is visible before setting its initial scroll position", async t => {
  let finish!: (data: unknown) => void;
  t.mock.method(apiClient, "request", async (path: string) => path === "/api/teams/conversations" ? chats() : new Promise(resolve => { finish = resolve; }));
  const view = await mount(t, <TeamsConversations {...props} />), doc = view.dom.window.document;
  const scroll = doc.querySelector<HTMLElement>(".teams-message-scroll")!;
  Object.defineProperty(scroll, "scrollHeight", { configurable: true, value: 800 });
  await act(async () => { doc.querySelector<HTMLButtonElement>(".teams-mobile-toggle")!.click(); });
  await act(async () => { finish(page([message("late")])); });
  assert.equal(scroll.scrollTop, 0, "a hidden timeline must not consume its initial-scroll state");
  await act(async () => { doc.querySelector<HTMLButtonElement>(".teams-mobile-close")!.click(); });
  assert.equal(scroll.scrollTop, 800);
});
