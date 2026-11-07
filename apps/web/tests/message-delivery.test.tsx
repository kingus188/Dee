import test from "node:test";
import assert from "node:assert/strict";
import { act, useState } from "react";
import type { ConversationView } from "@assistant/contracts";
import { App } from "../dist/ui/App.js";
import { apiClient } from "../dist/api/socket.js";
import { mount } from "./dom.js";
import { useConversation } from "../dist/chat/useConversation.js";
import { ChatThread } from "../dist/chat/ChatThread.js";
import { Composer } from "../dist/chat/Composer.js";

function emptyView(conversationId: number): ConversationView {
  return { conversationId, entries: [], busy: false, live: {}, inbox: 0, notes: { todos: [], memos: [] }, usage: null, tasks: [], reminders: [], subagents: [], parentId: null };
}

test("发送确认和排队期间立即展示消息，正式历史先于确认到达也不重复", async t => {
  let emit!: (view: ConversationView) => void;
  let acknowledge!: (value: unknown) => void;
  let entryId: number | undefined;
  let sentId = "";
  const view: ConversationView = { conversationId: 7, entries: [{ id: 1, kind: "user", text: "上一条问题" }], busy: true, live: { text: "上一轮还在回复" }, inbox: 0, notes: { todos: [], memos: [] }, usage: null, tasks: [], reminders: [], subagents: [], parentId: null };
  t.mock.method(apiClient, "connect", async () => {});
  t.mock.method(apiClient, "onConnection", (callback: (state: "connected") => void) => { callback("connected"); return () => {}; });
  t.mock.method(apiClient, "onView", (callback: (view: ConversationView) => void) => { emit = callback; return () => {}; });
  t.mock.method(apiClient, "subscribeConversation", async () => { emit(view); });
  t.mock.method(apiClient, "request", async (path: string, body?: { requestId?: string }) => {
    if (path === "/api/info") return { configured: true, boots: 1 };
    if (path === "/api/conversations/direct") return { id: 7 };
    if (path === "/api/conversations/7/messages" && body) {
      sentId = body.requestId!;
      return new Promise(resolve => { acknowledge = resolve; });
    }
    if (path.startsWith("/api/conversations/7/messages?")) {
      assert.equal(new URL(path, "http://localhost").searchParams.get("requestId"), sentId);
      return { submissionId: 9, status: entryId === undefined ? "queued" : "placed", entryId };
    }
    return { schedules: [], reminders: [], background: [], memory: [], skills: [], knowledge: { enabled: false, allow: [] }, items: [] };
  });
  const { dom } = await mount(t, <App />);
  const doc = dom.window.document;
  await act(async () => { doc.querySelector<HTMLButtonElement>('[aria-label="继续对话"]')!.click(); });
  const textarea = doc.querySelector<HTMLTextAreaElement>("textarea")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, "新发的问题");
    textarea.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  });
  await act(async () => { doc.getElementById("btn-send")!.click(); });
  assert.equal(doc.querySelectorAll(".user-bubble").length, 2);
  assert.match(doc.getElementById("message-history")!.textContent!, /新发的问题/);
  assert.match(doc.getElementById("message-history")!.textContent!, /正在发送/);
  await act(async () => { emit({ ...view, inbox: 1 }); });
  assert.equal(doc.querySelectorAll(".user-bubble").length, 2);
  assert.match(doc.getElementById("message-history")!.textContent!, /等待处理/);
  entryId = 5;
  await act(async () => { emit({ ...view, inbox: 0, entries: [...view.entries, { id: 5, kind: "user", text: "新发的问题" }] }); });
  assert.equal(doc.querySelectorAll(".user-bubble").length, 2);
  assert.doesNotMatch(doc.getElementById("message-history")!.textContent!, /正在发送|等待处理/);
  await act(async () => { acknowledge({ submissionId: 9 }); });
  assert.equal(doc.querySelectorAll(".user-bubble").length, 2);
  assert.equal(textarea.value, "");
});

test("连接等待期间展示附件，相同文字独立发送并按记录编号合并", async t => {
  let emit!: (view: ConversationView) => void;
  let connected!: () => void;
  const connection = new Promise<void>(resolve => { connected = resolve; });
  const entries = new Map<string, number>();
  const calls: string[] = [];
  t.mock.method(apiClient, "connect", async () => {});
  t.mock.method(apiClient, "onConnection", () => () => {});
  t.mock.method(apiClient, "onView", (callback: (view: ConversationView) => void) => { emit = callback; return () => {}; });
  t.mock.method(apiClient, "subscribeConversation", async () => { await connection; emit(emptyView(7)); });
  t.mock.method(apiClient, "request", async (path: string, body?: { requestId: string }) => {
    if (body) { calls.push(body.requestId); return { submissionId: calls.length }; }
    const entryId = entries.get(new URL(path, "http://localhost").searchParams.get("requestId")!);
    return { submissionId: 1, status: entryId ? "placed" : "queued", entryId };
  });
  let current!: ReturnType<typeof useConversation>;
  function Harness() { current = useConversation(7); return <ChatThread view={current.view} pendingMessages={current.pendingMessages} />; }
  const { dom } = await mount(t, <Harness />);
  let sent!: Promise<void>;
  await act(async () => {
    sent = current.send({ text: "相同内容", requestId: "first" }, [{ kind: "image", name: "pixel.png", mimeType: "image/png", data: "eA==", size: 1 }]);
  });
  assert.equal(calls.length, 0);
  assert.match(dom.window.document.body.textContent!, /相同内容.*正在发送/s);
  assert.equal(dom.window.document.querySelector("img")!.getAttribute("src"), "data:image/png;base64,eA==");
  await act(async () => { connected(); await sent; });
  await act(async () => { await current.send({ text: "相同内容", requestId: "second" }, []); });
  assert.equal(dom.window.document.querySelectorAll(".user-bubble").length, 2);
  entries.set("first", 10);
  await act(async () => { emit({ ...emptyView(7), inbox: 1, entries: [{ id: 10, kind: "user", text: "相同内容" }] }); });
  assert.equal(current.pendingMessages.length, 1);
  assert.equal(current.pendingMessages[0].requestId, "second");
  assert.equal(dom.window.document.querySelectorAll(".user-bubble").length, 2);
  entries.set("second", 11);
  await act(async () => { emit({ ...emptyView(7), entries: [{ id: 10, kind: "user", text: "相同内容" }, { id: 11, kind: "user", text: "相同内容" }] }); });
  assert.equal(current.pendingMessages.length, 0);
  assert.equal(dom.window.document.querySelectorAll(".user-bubble").length, 2);
});

test("断线保留草稿与未确认消息，重试复用标识且停止排队后不伪造处理状态", async t => {
  let emit!: (view: ConversationView) => void;
  let current!: ReturnType<typeof useConversation>;
  let failed = true, stopped = false;
  const ids: string[] = [];
  t.mock.method(apiClient, "connect", async () => {});
  t.mock.method(apiClient, "onConnection", () => () => {});
  t.mock.method(apiClient, "onView", (callback: (view: ConversationView) => void) => { emit = callback; return () => {}; });
  t.mock.method(apiClient, "subscribeConversation", async () => { emit(emptyView(7)); });
  t.mock.method(apiClient, "request", async (_path: string, body?: { requestId: string }) => {
    if (body) { ids.push(body.requestId); if (failed) throw new Error("连接中断"); return { submissionId: 1 }; }
    return failed ? null : { submissionId: 1, status: stopped ? "unanswered" : "queued" };
  });
  function Harness() {
    const chat = useConversation(7), [draft, setDraft] = useState("断线后重试");
    current = chat;
    return <><ChatThread view={chat.view} pendingMessages={chat.pendingMessages} /><Composer draft={draft} setDraft={setDraft} view={chat.view} connect={chat.connectDirectChat} send={chat.send} onSent={() => {}} onNewConversation={async () => {}} /></>;
  }
  const { dom } = await mount(t, <Harness />);
  const doc = dom.window.document;
  await act(async () => { await current.connectDirectChat(); });
  assert.equal(doc.querySelector<HTMLButtonElement>("#btn-send")!.disabled, false);
  await act(async () => { doc.getElementById("btn-send")!.click(); });
  assert.equal(doc.querySelector("textarea")!.value, "断线后重试");
  assert.match(doc.querySelector(".message-delivery-status")!.textContent!, /发送未确认/);
  failed = false;
  await act(async () => { doc.getElementById("btn-send")!.click(); });
  assert.equal(ids.length, 2); assert.equal(ids[0], ids[1]);
  assert.equal(doc.querySelectorAll(".user-bubble").length, 1);
  assert.equal(doc.querySelector("textarea")!.value, "");
  assert.match(doc.querySelector(".message-delivery-status")!.textContent!, /等待处理/);
  stopped = true;
  await act(async () => { emit({ ...emptyView(7), entries: [{ id: 20, kind: "assistant", text: "上一轮已停止" }] }); });
  assert.match(doc.querySelector(".message-delivery-status")!.textContent!, /已停止处理/);
  assert.doesNotMatch(doc.body.textContent!, /思考中|等待处理/);
});

test("切换会话后旧发送确认不清空新草稿，也不把消息显示到新会话", async t => {
  let emit!: (view: ConversationView) => void;
  let acknowledge!: (value: unknown) => void;
  const paths: string[] = [];
  t.mock.method(apiClient, "connect", async () => {});
  t.mock.method(apiClient, "onConnection", () => () => {});
  t.mock.method(apiClient, "onView", (callback: (view: ConversationView) => void) => { emit = callback; return () => {}; });
  t.mock.method(apiClient, "subscribeConversation", async (id: number) => { emit(emptyView(id)); });
  t.mock.method(apiClient, "request", async (path: string, body?: unknown) => {
    if (body) { paths.push(path); return new Promise(resolve => { acknowledge = resolve; }); }
    return { submissionId: 1, status: "queued" };
  });
  let current!: ReturnType<typeof useConversation>, setDraft!: (text: string) => void;
  let sent = 0;
  function Harness() {
    current = useConversation(7);
    const [draft, changeDraft] = useState("原会话消息"); setDraft = changeDraft;
    return <><ChatThread view={current.view} pendingMessages={current.pendingMessages} /><Composer draft={draft} setDraft={changeDraft} view={current.view} connect={current.connectDirectChat} send={current.send} onSent={() => { sent++; }} onNewConversation={async () => {}} /></>;
  }
  const { dom } = await mount(t, <Harness />);
  await act(async () => { await current.openConversation(7); });
  await act(async () => { dom.window.document.getElementById("btn-send")!.click(); });
  await act(async () => { await current.openConversation(8); setDraft("新会话草稿"); });
  await act(async () => { acknowledge({ submissionId: 1 }); });
  assert.deepEqual(paths, ["/api/conversations/7/messages"]);
  assert.equal(current.view?.conversationId, 8);
  assert.equal(dom.window.document.querySelector("textarea")!.value, "新会话草稿");
  assert.equal(dom.window.document.querySelectorAll(".user-bubble").length, 0);
  assert.equal(sent, 0);
  await act(async () => { await current.openConversation(7); });
  assert.match(dom.window.document.querySelector(".user-bubble")!.textContent!, /原会话消息/);
});
