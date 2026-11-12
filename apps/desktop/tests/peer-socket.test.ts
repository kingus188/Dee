import test from "node:test";
import assert from "node:assert/strict";
import { openPeerSocket } from "../dist/peer-socket.js";

class Socket extends EventTarget {
  readyState = 0; bufferedAmount = 0; sent: string[] = [];
  open() { this.readyState = 1; this.dispatchEvent(new Event("open")); this.frame({ type: "peer-authenticated" }); }
  close() { this.readyState = 3; this.dispatchEvent(new Event("close")); }
  send(text: unknown) { if (JSON.parse(String(text)).type !== "peer-auth") this.sent.push(String(text)); }
  frame(value: unknown) { const event = new Event("message"); Object.defineProperty(event, "data", { value: JSON.stringify(value) }); this.dispatchEvent(event); }
}
const settle = () => new Promise<void>(resolve => setImmediate(resolve));

test("peer RPC multiplexes out-of-order responses and pushes, reconnects without replaying unknown writes", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const sockets: Socket[] = [], changes: string[] = [];
  const client = openPeerSocket({ target: () => ({ key: "server-a", url: "ws://server-a/api/peers/socket", origin: "http://server-a", headers: {} }), socket: () => {
    const socket = new Socket(); sockets.push(socket); queueMicrotask(() => socket.open()); return socket;
  } });
  client.onChange(change => changes.push(change));
  try {
    const a = client.request("/api/peers/tasks", { id: "durable-write" }), b = client.request("/api/info");
    await settle(); assert.equal(sockets.length, 1);
    const [first, second] = sockets[0]!.sent.map(text => JSON.parse(text));
    sockets[0]!.frame({ type: "response", id: second.id, status: 200, data: "b" });
    sockets[0]!.frame({ type: "response", id: first.id, status: 202, data: "a" });
    assert.equal(await a, "a"); assert.equal(await b, "b");
    sockets[0]!.frame({ type: "event", event: "peer-tasks", data: { deviceId: "desktop-fixture" } });
    assert.ok(changes.includes("tasks"));
    const unknown = client.request("/api/peers/tasks", { id: "unknown-write" }); await settle();
    const rejected = assert.rejects(unknown, /结果尚未确认/); sockets[0]!.close(); await rejected;
    t.mock.timers.tick(1000); await settle();
    assert.equal(sockets.length, 2); assert.equal(sockets[1]!.sent.length, 0, "reconnect does not replay writes");
    const next = client.request("/api/info"); await settle();
    const input = JSON.parse(sockets[1]!.sent[0]!);
    sockets[1]!.frame({ type: "response", id: input.id, status: 200, data: "new" });
    assert.equal(await next, "new");
    client.close(); t.mock.timers.tick(60000); await settle(); assert.equal(sockets.length, 2);
  } finally { client.close(); }
});

test("server switches fence old frames; malformed responses and backpressure fail explicitly", async () => {
  let server = "a";
  const sockets: Socket[] = [];
  const client = openPeerSocket({ target: () => ({ key: server, url: `ws://${server}/api/peers/socket`, origin: `http://${server}`, headers: {} }), socket: () => {
    const socket = new Socket(); sockets.push(socket); queueMicrotask(() => socket.open()); return socket;
  } });
  try {
    const old = client.request("/api/info"); await settle(); const oldInput = JSON.parse(sockets[0]!.sent[0]!);
    const rejected = assert.rejects(old, /尚未确认/); server = "b";
    const next = client.request("/api/info"); await rejected; await settle();
    const input = JSON.parse(sockets[1]!.sent[0]!);
    sockets[0]!.frame({ type: "response", id: input.id, status: 200, data: "wrong server" });
    sockets[1]!.frame({ type: "response", id: input.id, status: 200, data: "correct server" });
    assert.equal(await next, "correct server"); assert.notEqual(input.id, oldInput.id);
    sockets[1]!.bufferedAmount = 17 * 1024 * 1024;
    await assert.rejects(client.request("/api/info"), { status: 429 }); sockets[1]!.bufferedAmount = 0;
    const invalid = client.request("/api/info"); await settle(); const invalidRejected = assert.rejects(invalid, { status: 502 });
    sockets[1]!.frame({ type: "response", id: "invalid", status: "200" }); await invalidRejected;
  } finally { client.close(); }
});
