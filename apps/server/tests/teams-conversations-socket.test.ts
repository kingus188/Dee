import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import WebSocket from "ws";
import { attachWebSocket } from "../dist/http/socket.js";

test("WebSocket transports bounded encoded Teams pagination cursors beyond the ordinary route limit", async t => {
  const server = createServer(), seen: URL[] = [];
  const context = { redact: () => "", exitIfFatal: () => {} } as unknown as Parameters<typeof attachWebSocket>[1];
  const api = { dispatch: async (_method: string, url: URL) => { seen.push(url); return { status: 200, data: { ok: true } }; } } as unknown as Parameters<typeof attachWebSocket>[2];
  const close = attachWebSocket(server, context, api, () => true);
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); assert.ok(address && typeof address === "object");
  t.after(async () => { close(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const socket = new WebSocket(`ws://127.0.0.1:${address.port}/api/socket`); await once(socket, "open");
  const cursor = "https://graph.microsoft.com/v1.0/chats/chat/messages?$skiptoken=" + "a+/=".repeat(2000);
  for (const path of ["/api/teams/conversations?cursor=", "/api/teams/conversations/messages?chatId=chat&cursor="]) {
    const response = once(socket, "message");
    socket.send(JSON.stringify({ type: "request", id: path, method: "GET", path: path + encodeURIComponent(cursor) }));
    assert.equal(JSON.parse(String((await response)[0])).status, 200);
    assert.equal(seen.at(-1)!.searchParams.get("cursor"), cursor);
  }
  socket.close(); await once(socket, "close");
  for (const path of ["/api/other?cursor=" + "a".repeat(5000), "/api/teams/conversations?cursor=" + "a".repeat(64_001)]) {
    const denied: WebSocket = new WebSocket(`ws://127.0.0.1:${address.port}/api/socket`); await once(denied, "open");
    const closed: Promise<unknown[]> = once(denied, "close");
    denied.send(JSON.stringify({ type: "request", id: "oversized", method: "GET", path }));
    assert.equal((await closed)[0], 1008);
  }
  assert.equal(seen.length, 2);
});
