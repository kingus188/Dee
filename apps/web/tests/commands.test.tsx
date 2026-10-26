import test from "node:test";
import assert from "node:assert/strict";
import { act, useState } from "react";
import type { ConversationView } from "@assistant/contracts";
import { Composer } from "../dist/chat/Composer.js";
import { commandSuggestions, parseCommand } from "../dist/chat/commands.js";
import { useConversation } from "../dist/chat/useConversation.js";
import { apiClient } from "../dist/api/socket.js";
import { mount } from "./dom.js";

const view = (conversationId: number, busy = false) => ({ conversationId, busy, live: {}, inbox: 0, entries: [] }) as unknown as ConversationView;

test("指令按前缀筛选，只识别独占一行的指令；正文与文件路径不误判", () => {
  assert.deepEqual(commandSuggestions("/").map(item => item.name), ["new", "help", "stop"]);
  assert.deepEqual(commandSuggestions("/NE").map(item => item.name), ["new"]);
  assert.equal(commandSuggestions("/unknown").length, 0);
  assert.deepEqual(parseCommand(" /STOP \t "), { name: "stop", args: "" });
  assert.deepEqual(parseCommand("/new hello"), { name: "new", args: "hello" });
  for (const text of ["请解释 /new", "/new\n这只是示例", "/tmp/test.txt", "https://example.com/new"]) assert.equal(parseCommand(text), null);
});

test("斜杠菜单支持筛选、上下键、Tab、Escape，输入法与 Shift+Enter 不执行", async t => {
  let change!: (value: string) => void;
  let created = 0;
  const calls: string[] = [];
  t.mock.method(apiClient, "request", async (path: string) => { calls.push(path); return {}; });
  function Harness() {
    const [draft, setDraft] = useState("/"); change = setDraft;
    return <Composer draft={draft} setDraft={setDraft} view={view(7)} connect={async () => 7} onSent={() => {}} onNewConversation={async () => { created++; }} />;
  }
  const { dom } = await mount(t, <Harness />);
  const input = dom.window.document.querySelector("textarea")!;
  async function key(key: string, options: KeyboardEventInit = {}) {
    await act(async () => { input.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key, bubbles: true, ...options })); });
  }
  assert.equal(dom.window.document.querySelectorAll('[role="option"]').length, 3);
  await key("ArrowUp"); assert.equal(input.getAttribute("aria-activedescendant"), "command-stop");
  await key("ArrowDown"); assert.equal(input.getAttribute("aria-activedescendant"), "command-new");
  await key("ArrowDown"); await key("Tab"); assert.equal(input.value, "/help");
  await key("Escape"); assert.equal(input.getAttribute("aria-expanded"), "false");
  await act(async () => change("/ne"));
  assert.equal(dom.window.document.querySelectorAll('[role="option"]').length, 1);
  await key("Enter", { isComposing: true }); await key("Enter", { keyCode: 229 }); await key("Enter", { shiftKey: true });
  assert.equal(created, 0); assert.equal(calls.length, 0);
  await key("Enter");
  assert.equal(created, 1); assert.equal(input.value, ""); assert.equal(calls.length, 0);
});

test("/help 本地展示，/stop 只停止当前回复，未知指令和参数不送给模型", async t => {
  let change!: (value: string) => void;
  let newAttempts = 0;
  const calls: string[] = [];
  t.mock.method(apiClient, "request", async (path: string) => { calls.push(path); return {}; });
  function Harness({ busy }: { busy: boolean }) {
    const [draft, setDraft] = useState("/help"); change = setDraft;
    return <Composer draft={draft} setDraft={setDraft} view={view(7, busy)} connect={async () => { throw new Error("不该连接"); }} onSent={() => {}} onNewConversation={async () => { newAttempts++; throw new Error("不该新建"); }} />;
  }
  const { dom, render } = await mount(t, <Harness busy />);
  const doc = dom.window.document;
  async function send(text?: string) {
    if (text !== undefined) await act(async () => change(text));
    await act(async () => doc.querySelector<HTMLButtonElement>("#btn-send")!.click());
  }
  await send(); assert.equal(calls.length, 0);
  assert.match(doc.querySelector(".command-menu")!.textContent!, /快捷指令.*\/new.*\/help.*\/stop/s);
  await render(<Harness busy={false} />);
  await act(async () => doc.querySelector("textarea")!.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
  assert.equal(newAttempts, 0, "帮助显示后，空草稿的 Enter 不能意外新建会话");
  await render(<Harness busy />);
  await send("/new"); assert.equal(doc.querySelector("textarea")!.value, "/new");
  assert.match(doc.getElementById("toast-container")!.textContent!, /请先.*停止/);
  await send("/stop"); assert.deepEqual(calls, ["/api/conversations/7/abort"]);
  await render(<Harness busy={false} />);
  await send("/stop"); assert.equal(calls.length, 1);
  assert.match(doc.getElementById("toast-container")!.textContent!, /没有正在生成/);
  for (const text of ["/unknown", "/new hello"]) { await send(text); assert.equal(doc.querySelector("textarea")!.value, text); }
  assert.equal(calls.length, 1);
  await send("请解释 /new"); assert.match(doc.getElementById("toast-container")!.textContent!, /发送未确认/);
});

test("新建并发只执行一次，失败保留草稿，完成不覆盖新草稿；附件不被指令丢弃", async t => {
  let change!: (value: string) => void;
  let resolve!: () => void;
  const pending = new Promise<void>(done => { resolve = done; });
  let attempts = 0;
  function Harness() {
    const [draft, setDraft] = useState("/new"); change = setDraft;
    return <Composer draft={draft} setDraft={setDraft} view={view(7)} connect={async () => 7} onSent={() => {}} onNewConversation={async () => { if (++attempts === 1) throw new Error("连接中断"); await pending; }} />;
  }
  const { dom } = await mount(t, <Harness />);
  const doc = dom.window.document, input = doc.querySelector("textarea")!;
  const send = doc.querySelector<HTMLButtonElement>("#btn-send")!;
  await act(async () => send.click());
  assert.equal(input.value, "/new"); assert.match(doc.getElementById("toast-container")!.textContent!, /指令未完成.*连接中断/);
  await act(async () => { send.click(); input.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true })); });
  assert.equal(attempts, 2);
  await act(async () => change("新对话的问题"));
  await act(async () => resolve()); assert.equal(input.value, "新对话的问题");
  const file = doc.querySelector<HTMLInputElement>('input[type="file"]')!;
  Object.defineProperty(file, "files", { configurable: true, value: [new File(["hello"], "note.txt", { type: "text/plain" })] });
  await act(async () => file.dispatchEvent(new dom.window.Event("change", { bubbles: true })));
  await act(async () => change("/new"));
  await act(async () => send.click());
  assert.equal(attempts, 2); assert.equal(input.value, "/new");
  assert.match(doc.querySelector(".attachments-preview")!.textContent!, /note.txt/);
  assert.match(doc.getElementById("toast-container")!.textContent!, /先发送或移除附件/);
});

test("新会话订阅去重、等待初始连接，旧事件不回填；订阅失败不再向旧会话发送", async t => {
  t.mock.method(apiClient, "connect", async () => {});
  t.mock.method(apiClient, "onConnection", () => () => {});
  let listener!: (data: ConversationView) => void;
  t.mock.method(apiClient, "onView", (callback: (data: ConversationView) => void) => { listener = callback; return () => {}; });
  let opened!: (value: { id: number }) => void;
  const first = new Promise<{ id: number }>(resolve => { opened = resolve; });
  const requests: string[] = [], subscriptions: number[] = [];
  let subscribeFailure = false, requestFailure = false;
  t.mock.method(apiClient, "request", async (path: string) => {
    requests.push(path);
    if (requestFailure) throw new Error("新建失败");
    if (path.endsWith("/new")) return { id: requests.length === 2 ? 8 : 9 };
    return requests.length === 1 ? first : { id: 9 };
  });
  t.mock.method(apiClient, "subscribeConversation", async (id: number) => {
    subscriptions.push(id);
    if (subscribeFailure) throw new Error("订阅失败");
    listener(view(id));
    return {};
  });
  let current!: ReturnType<typeof useConversation>;
  function Harness() { current = useConversation(); return <p>{current.view?.conversationId ?? "空白"}</p>; }
  const { dom } = await mount(t, <Harness />);
  const initial = current.connectDirectChat();
  let next!: Promise<number>;
  await act(async () => {
    next = current.newConversation();
    assert.equal(current.newConversation(), next);
    assert.equal(current.connectDirectChat(), next);
    assert.equal(requests.length, 1);
    opened({ id: 7 }); await initial; await next;
  });
  assert.deepEqual(subscriptions, [7, 8]); assert.equal(dom.window.document.querySelector("p")!.textContent, "8");
  assert.equal(await current.connectDirectChat(), 8);
  requestFailure = true;
  await act(async () => { await assert.rejects(current.newConversation(), /新建失败/); });
  assert.equal(dom.window.document.querySelector("p")!.textContent, "8");
  assert.equal(await current.connectDirectChat(), 8, "创建前失败仍可继续原会话");
  requestFailure = false;
  subscribeFailure = true;
  await act(async () => { await assert.rejects(current.newConversation(), /订阅失败/); });
  assert.equal(dom.window.document.querySelector("p")!.textContent, "空白");
  subscribeFailure = false;
  await act(async () => { assert.equal(await current.connectDirectChat(), 9); });
  assert.equal(requests.at(-1), "/api/conversations/direct/new");
  assert.equal(subscriptions.at(-1), 9);
});
