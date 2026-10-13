import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import type { ClientOptions } from "ws";
import type { ApiResponse, ConversationView, ServerMessage } from "@assistant/contracts";
import { startServer } from "../dist/lifecycle.js";
import { readConfig } from "../dist/config.js";

async function open(origin: string, options: ClientOptions = {}) {
  const socket = new WebSocket(origin.replace(/^http/, "ws") + "/api/socket", options);
  await once(socket, "open");
  return socket;
}
function channel(socket: WebSocket) {
  let nextId = 0;
  const requests = new Map<string, (response: ApiResponse) => void>();
  const views: ConversationView[] = [];
  socket.on("message", data => {
    const message: ServerMessage = JSON.parse(data.toString());
    if (message.type === "response") { requests.get(message.id)?.(message); requests.delete(message.id); }
    else { views.push(message.data); if (views.length > 100) views.shift(); }
  });
  return {
    async request(path: string, body?: unknown) {
      const id = String(++nextId);
      const response = await new Promise<ApiResponse>((resolve, reject) => {
        const timer = setTimeout(() => { requests.delete(id); reject(new Error("RPC 超时")); }, 15000);
        requests.set(id, data => { clearTimeout(timer); resolve(data); });
        socket.send(JSON.stringify({ type: "request", id, path, method: body === undefined ? "GET" : "POST", body }));
      });
      return response;
    },
    async view(predicate: (view: ConversationView) => boolean) {
      for (let i = 0; i < 600; i++) {
        const found = views.findLast(predicate);
        if (found) return found;
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      throw new Error("未收到期望的会话快照");
    },
  };
}

test("真实 WebSocket 完成发送、附件、去重、重连、任务、记忆与停止，关闭服务释放连接", { timeout: 40000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-ws-"));
  const server = await startServer(readConfig({ NODE_ENV: "test", LLM_API: "faux", DATA_DIR: dir, PORT: "0", NOTIFY_MODE: "off" }));
  const sockets: WebSocket[] = [];
  try {
    let socket = await open(server.origin); sockets.push(socket);
    let rpc = channel(socket);
    const opened = await rpc.request("/api/conversations/direct", {});
    assert.equal(opened.status, 200);
    const { id } = opened.data as { id: number };
    assert.equal((await rpc.request(`/api/conversations/${id}/events`)).status, 200);
    assert.equal((await rpc.view(view => view.conversationId === id)).entries.length, 0);
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7l8AAAAASUVORK5CYII=", "base64");
    const body = { text: "WebSocket 对话", requestId: "ws-once", attachments: [
      { name: "note.md", mimeType: "text/markdown", data: Buffer.from("笔记").toString("base64") },
      { name: "pixel.png", mimeType: "image/png", data: png.toString("base64") },
    ] };
    const sent = await rpc.request(`/api/conversations/${id}/messages`, body);
    assert.equal(sent.status, 202);
    assert.deepEqual((await rpc.request(`/api/conversations/${id}/messages`, body)).data, sent.data);
    const done = await rpc.view(view => !view.busy && view.entries.some(entry => entry.text === "演示任务完成。"));
    assert.equal(done.entries.filter(entry => entry.kind === "user").length, 1);
    assert.equal(done.entries.find(entry => entry.kind === "user")!.attachments?.length, 2);
    assert.equal((await rpc.request(`/api/conversations/${id}/management`)).status, 200);
    assert.equal((await rpc.request("/api/personal/memory", { text: "简洁回复", requestId: "ws-memory" })).status, 201);
    assert.equal((await rpc.request("/api/personal")).status, 200);
    assert.equal((await rpc.request(`/api/conversations/${id}/messages`, { text: "", attachments: [] })).status, 400);
    assert.equal((await rpc.request("/api/missing")).status, 404);
    socket.close(); await once(socket, "close");
    socket = await open(server.origin); sockets.push(socket); rpc = channel(socket);
    assert.equal((await rpc.request(`/api/conversations/${id}/events`)).status, 200);
    assert.equal((await rpc.view(view => view.conversationId === id)).entries.filter(entry => entry.kind === "user").length, 1);
    await rpc.request(`/api/conversations/${id}/messages`, { text: "停止检查", requestId: "ws-abort" });
    await rpc.view(view => !!view.live.tools?.some(tool => tool.name === "wait_seconds" && tool.status === "running"));
    assert.equal((await rpc.request(`/api/conversations/${id}/abort`, {})).status, 200);
    await rpc.view(view => !view.busy && view.entries.some(entry => entry.text === "停止检查"));
    const closed = once(socket, "close"); await server.close(); await closed;
  } finally { for (const socket of sockets) socket.terminate(); await server.close(); await rm(dir, { recursive: true, force: true }); }
});

test("WebSocket 握手验证 Basic Auth 与 Origin，非法 JSON 和超大帧被拒绝", { timeout: 20000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-ws-auth-"));
  const server = await startServer(readConfig({ NODE_ENV: "test", LLM_API: "faux", DATA_DIR: dir, PORT: "0", DEMO_PASSWORD: "test-password", NOTIFY_MODE: "off" }), "127.0.0.1");
  const headers = { Authorization: "Basic " + Buffer.from("demo:test-password").toString("base64"), Origin: server.origin };
  const sockets: WebSocket[] = [];
  async function rejected(extra: Record<string, string>) {
    const socket = new WebSocket(server.origin.replace(/^http/, "ws") + "/api/socket", { headers: extra });
    sockets.push(socket); socket.on("error", () => {});
    return new Promise<number>(resolve => { socket.once("unexpected-response", (_req, response) => { resolve(response.statusCode!); response.resume(); socket.terminate(); }); });
  }
  try {
    assert.equal(await rejected({ Origin: server.origin }), 401);
    assert.equal(await rejected({ ...headers, Origin: "https://other.example" }), 403);
    let socket = await open(server.origin, { headers }); sockets.push(socket);
    const rpc = channel(socket);
    assert.equal((await rpc.request("/api/info")).status, 200);
    const opened = await rpc.request("/api/conversations/direct", {});
    const { id } = opened.data as { id: number };
    const image = Buffer.alloc(5 * 1024 * 1024);
    Buffer.from("89504e470d0a1a0a", "hex").copy(image);
    const encoded = image.toString("base64");
    const maximum = await rpc.request(`/api/conversations/${id}/messages`, {
      text: "中".repeat(8000), requestId: "ws-maximum",
      attachments: ["one.png", "two.png"].map(name => ({ name, mimeType: "image/png", data: encoded })),
    });
    assert.equal(maximum.status, 202, JSON.stringify(maximum));
    assert.equal((await rpc.request(`/api/conversations/${id}/abort`, {})).status, 200);
    let closed = once(socket, "close"); socket.send("not json"); assert.equal((await closed)[0], 1008);
    socket = await open(server.origin, { headers }); sockets.push(socket);
    closed = once(socket, "close"); socket.send("x".repeat(14 * 1024 * 1024 + 1)); assert.equal((await closed)[0], 1009);
  } finally { for (const socket of sockets) socket.terminate(); await server.close(); await rm(dir, { recursive: true, force: true }); }
});
