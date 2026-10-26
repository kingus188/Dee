import test from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import WebSocket from "ws";
import type { ApiRequest, ApiResponse, NotesEditRequest } from "@assistant/contracts";
import { attachWebSocket } from "../dist/http/socket.js";

async function openSocket(t: TestContext) {
  const server = createServer();
  // Exercise the production transport without starting application services or a database.
  const context = { config: { password: "" }, redact: String, exitIfFatal: () => {} } as unknown as Parameters<typeof attachWebSocket>[1];
  const api = {
    async dispatch(method: string, url: URL, body: Record<string, unknown>) {
      return { status: 200, data: { method, path: url.pathname, body } };
    },
  } as unknown as Parameters<typeof attachWebSocket>[2];
  const closeSockets = attachWebSocket(server, context, api, () => true);
  t.after(async () => {
    closeSockets();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const socket = new WebSocket(`ws://127.0.0.1:${address.port}/api/socket`);
  await once(socket, "open");
  return socket;
}

async function request(socket: WebSocket, frame: ApiRequest | string) {
  const received = once(socket, "message");
  socket.send(typeof frame === "string" ? frame : JSON.stringify(frame));
  const [data] = await received;
  return JSON.parse(data.toString()) as ApiResponse;
}

function sizedRequest(path: string, bytes: number, method: ApiRequest["method"] = "POST") {
  const notes = { todos: [], memos: [] };
  const text = JSON.stringify({ type: "request", id: "limit", method, path, body: { notes, base: notes } });
  // JSON whitespace exercises the full frame limit without exceeding the notes schema.
  return text + " ".repeat(bytes - Buffer.byteLength(text));
}

test("notes POST accepts two 16000-character Chinese memos and their base over WebSocket", { timeout: 5000 }, async t => {
  const socket = await openSocket(t);
  const notes = { todos: [], memos: ["中".repeat(16000), "文".repeat(16000)] };
  const body: NotesEditRequest = { notes, base: notes };
  const frame: ApiRequest = { type: "request", id: "1", method: "POST", path: "/api/conversations/1/notes", body };
  const bytes = Buffer.byteLength(JSON.stringify(frame));
  assert.ok(bytes > 100_000 && bytes < 2_000_000);
  const response = await request(socket, frame);
  assert.equal(response.status, 200, `${bytes}-byte notes frame: ${JSON.stringify(response)}`);
  assert.deepEqual(response.data, { method: "POST", path: frame.path, body });
});

test("notes POST permits exactly 2000000 bytes and rejects the next byte without closing the socket", { timeout: 5000 }, async t => {
  const socket = await openSocket(t);
  assert.equal((await request(socket, sizedRequest("/api/conversations/42/notes", 2_000_000))).status, 200);
  const tooLarge = await request(socket, sizedRequest("/api/conversations/42/notes", 2_000_001));
  assert.equal(tooLarge.status, 413);
  assert.equal(tooLarge.error, "请求太大");
  assert.equal((await request(socket, sizedRequest("/api/conversations/42/notes", 200))).status, 200);
});

test("ordinary requests retain the inclusive 100000-byte frame limit", { timeout: 5000 }, async t => {
  const socket = await openSocket(t);
  assert.equal((await request(socket, sizedRequest("/api/settings/model", 100_000))).status, 200);
  assert.equal((await request(socket, sizedRequest("/api/settings/model", 100_001))).status, 413);
});

test("the larger notes allowance requires POST and an exact numeric conversation notes pathname", { timeout: 5000 }, async t => {
  const socket = await openSocket(t);
  const cases: { method: ApiRequest["method"]; path: string }[] = [
    { method: "GET", path: "/api/conversations/1/notes" },
    { method: "POST", path: "/api/conversations/direct/notes" },
    { method: "POST", path: "/api/conversations/-1/notes" },
    { method: "POST", path: "/api/conversations/1.5/notes" },
    { method: "POST", path: "/api/conversations/1/notes-extra" },
    { method: "POST", path: "/api/conversations/1/notes/" },
    { method: "POST", path: "/api/conversations/1/notes/save" },
    { method: "POST", path: "/api/other/conversations/1/notes" },
  ];
  for (const { method, path } of cases) {
    await t.test(`${method} ${path}`, async () => {
      assert.equal((await request(socket, sizedRequest(path, 100_001, method))).status, 413);
    });
  }
  assert.equal((await request(socket, sizedRequest("/api/conversations/1/notes?source=editor", 100_001))).status, 200);
});

test("existing message and Daylight save routes retain their larger frame allowance", { timeout: 5000 }, async t => {
  const socket = await openSocket(t);
  for (const path of ["/api/conversations/1/messages", "/api/daylight/tasks/save"]) {
    await t.test(path, async () => {
      assert.equal((await request(socket, sizedRequest(path, 2_000_001))).status, 200);
    });
  }
});

test("large notes requests still enforce the WebSocket request schema", { timeout: 5000 }, async t => {
  for (const invalid of [
    { method: "PUT", body: {} },
    { method: "POST", body: [] },
    { method: "POST", body: null },
  ]) {
    await t.test(`${invalid.method} with ${JSON.stringify(invalid.body)}`, async t => {
      const socket = await openSocket(t);
      const closed = once(socket, "close");
      const text = JSON.stringify({ type: "request", id: "schema", path: "/api/conversations/1/notes", ...invalid });
      socket.send(text + " ".repeat(100_001 - Buffer.byteLength(text)));
      assert.equal((await closed)[0], 1008);
    });
  }
  await t.test("binary JSON remains invalid", async t => {
    const socket = await openSocket(t);
    const closed = once(socket, "close");
    socket.send(Buffer.from(sizedRequest("/api/conversations/1/notes", 100_001)));
    assert.equal((await closed)[0], 1008);
  });
});
