import test from "node:test";
import assert from "node:assert/strict";
import { ApiClient } from "../dist/api/socket.js";
import type { ApiRequest, ConversationView } from "@assistant/contracts";

class Socket {
  static OPEN = 1;
  static all: Socket[] = [];
  readyState = 0;
  sent: ApiRequest[] = [];
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  constructor() { Socket.all.push(this); }
  open() { this.readyState = 1; this.onopen?.(); }
  send(data: string) { this.sent.push(JSON.parse(data)); }
  close() { this.readyState = 3; this.onclose?.(); }
  response(id: string, data: unknown, status = 200) { this.onmessage?.({ data: JSON.stringify({ type: "response", id, data, status, error: status >= 400 ? "失败" : undefined }) }); }
}

test("WebSocket 请求相关联，断线不重放写入，重连恢复订阅，旧连接事件被忽略", async t => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "WebSocket");
  Object.defineProperty(globalThis, "WebSocket", { configurable: true, value: Socket }); Socket.all = [];
  t.after(() => { if (descriptor) Object.defineProperty(globalThis, "WebSocket", descriptor); else Reflect.deleteProperty(globalThis, "WebSocket"); });
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const client = new ApiClient(() => "ws://localhost/api/socket"); t.after(() => client.close());
  const received: number[] = []; client.onView(view => received.push(view.conversationId));
  const first = client.request("/api/info"), second = client.request("/api/personal");
  assert.equal(Socket.all.length, 1);
  const socket = Socket.all[0]; socket.open(); await Promise.resolve();
  socket.response(socket.sent[1].id, "personal"); socket.response(socket.sent[0].id, "info");
  assert.equal(await first, "info"); assert.equal(await second, "personal");
  const subscribed = client.subscribeConversation(7); await Promise.resolve(); await Promise.resolve();
  socket.response(socket.sent.at(-1)!.id, {}); await subscribed;
  const write = client.request("/api/conversations/7/messages", { text: "hello" }); await Promise.resolve();
  const rejected = assert.rejects(write, /尚未确认/); socket.close(); await rejected;
  t.mock.timers.tick(1000); assert.equal(Socket.all.length, 2);
  const next = Socket.all[1]; next.open(); await Promise.resolve(); await Promise.resolve();
  assert.deepEqual(next.sent.map(request => request.path), ["/api/conversations/7/events"]);
  next.response(next.sent[0].id, {});
  socket.onmessage?.({ data: JSON.stringify({ type: "event", event: "view", data: { conversationId: 7 } as ConversationView }) });
  next.onmessage?.({ data: JSON.stringify({ type: "event", event: "view", data: { conversationId: 8 } as ConversationView }) });
  next.onmessage?.({ data: JSON.stringify({ type: "event", event: "view", data: { conversationId: 7 } as ConversationView }) });
  assert.deepEqual(received, [7]);
  const timedOut = client.request("/api/info"); await Promise.resolve();
  const timeout = assert.rejects(timedOut, /请求超时/); t.mock.timers.tick(30_000); await timeout;
  client.close();
  await assert.rejects(client.connect(), /连接已关闭/);
  const resumed = client.resume(); const restored = Socket.all.at(-1)!; restored.open(); await resumed; await Promise.resolve();
  assert.equal(restored.sent[0].path, "/api/conversations/7/events"); restored.response(restored.sent[0].id, {});
});
