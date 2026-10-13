import test from "node:test";
import assert from "node:assert/strict";
import { createState } from "../dist/state.js";
import { createDirectChat } from "../dist/conversations/controller.js";
import { createChatComposer } from "../dist/chat/composer.js";

test("页面初始化和首次发送共用一次连接，失败后可重试", async t => {
  const state = createState();
  let finish!: (value: Response) => void;
  const fetch = t.mock.method(globalThis, "fetch", () => new Promise<Response>(resolve => { finish = resolve; }));
  const connected: (string | number)[] = [];
  const { connectDirectChat } = createDirectChat(state, () => ({ connectSse: id => connected.push(id), resetConversationCards() {} }));
  const first = connectDirectChat();
  const second = connectDirectChat();
  assert.equal(fetch.mock.callCount(), 1);
  finish(new Response(JSON.stringify({ id: 7 }), { status: 200 }));
  await Promise.all([first, second]);
  await connectDirectChat();
  assert.deepEqual(connected, [7]);
  assert.equal(fetch.mock.callCount(), 1);

  state.currentConversationId = null;
  const failed = connectDirectChat();
  finish(new Response(JSON.stringify({ error: "暂时不可用" }), { status: 503 }));
  await assert.rejects(failed, /暂时不可用/);
  const retry = connectDirectChat();
  finish(new Response(JSON.stringify({ id: 7 }), { status: 200 }));
  await retry;
  assert.equal(state.currentConversationId, 7);
});

test("首次连接时重复点发送不会重复提交，新话题无需选模式且不会清掉新草稿", async t => {
  const state = createState();
  const textarea = { value: "今天做什么", style: { height: "" } };
  const button = { disabled: false, innerHTML: "<svg></svg>", ariaBusy: "false", ariaLabel: "发送消息" };
  const original = Object.getOwnPropertyDescriptor(globalThis, "document");
  Object.defineProperty(globalThis, "document", { configurable: true, value: { getElementById: (id: string) => id === "chat-textarea" ? textarea : button } });
  t.after(() => { if (original) Object.defineProperty(globalThis, "document", original); else Reflect.deleteProperty(globalThis, "document"); });
  let connected!: () => void;
  const connection = new Promise<void>(resolve => { connected = resolve; });
  const fetch = t.mock.method(globalThis, "fetch", async () => new Response("{}", { status: 202 }));
  const composer = createChatComposer(state, () => ({
    connectDirectChat: async () => { await connection; state.currentConversationId = 7; },
    removePendingAttachment(index) { state.pendingAttachments.splice(index, 1); }, updateSendButtonState() {},
  }));
  state.pendingAttachments.push({ kind: "text", name: "first.txt", mimeType: "text/plain", data: "Zmlyc3Q=", size: 5 });
  const sending = composer.submitMessage();
  assert.equal(button.ariaBusy, "true");
  assert.equal(button.ariaLabel, "正在发送");
  assert.equal(button.innerHTML, "<svg></svg>");
  await composer.submitMessage();
  assert.equal(fetch.mock.callCount(), 0);
  textarea.value = "又想到另一件事";
  state.pendingAttachments.push({ kind: "text", name: "next.txt", mimeType: "text/plain", data: "bmV4dA==", size: 4 });
  connected();
  await sending;
  assert.equal(button.ariaBusy, "false");
  assert.equal(button.ariaLabel, "发送消息");
  assert.equal(button.innerHTML, "<svg></svg>");
  assert.equal(fetch.mock.callCount(), 1);
  const body = JSON.parse(String(fetch.mock.calls[0].arguments[1]?.body));
  assert.equal(body.mode, "steer");
  assert.equal(body.text, "今天做什么");
  assert.equal(textarea.value, "又想到另一件事");
  assert.deepEqual(state.pendingAttachments.map(file => file.name), ["next.txt"]);
  assert.equal(body.attachments[0].name, "first.txt");
});
