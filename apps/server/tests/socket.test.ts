import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
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
  const server = await startServer(readConfig({ NODE_ENV: "test", PI_OFFLINE: "1", LLM_API: "faux", DATA_DIR: dir, PORT: "0", NOTIFY_MODE: "off" }));
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
    const settings = await rpc.request("/api/settings/model");
    assert.equal(settings.status, 200);
    assert.equal(Object.hasOwn(settings.data as object, "apiKey"), false);
    const savedSettings = await rpc.request("/api/settings/model", { provider: "openai-completions", baseUrl: "http://127.0.0.1:1/v1", model: "test-model", apiKey: "socket-test-only-key" });
    assert.equal(savedSettings.status, 400);
    assert.equal(JSON.stringify(savedSettings).includes("socket-test-only-key"), false);
    assert.deepEqual((await rpc.request("/api/settings/model")).data, settings.data);
    const unchanged = await rpc.request("/api/settings/model", { modelId: "faux" });
    assert.equal(unchanged.status, 200);
    assert.deepEqual(unchanged.data, settings.data);
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

test("WebSocket 模型设置仅接受目录 id，目录连接和 Key 均不出站，保存需重启后端", { timeout: 20000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-ws-model-catalog-"));
  const file = join(directory, "models.json");
  await writeFile(file, JSON.stringify([
    { id: "fast", name: "快速", provider: "openai-completions", baseUrl: "https://private-provider.example/v1", model: "private-upstream-fast", apiKey: "ws-fast-test-key" },
    { id: "quality", name: "精准", provider: "anthropic-messages", baseUrl: "https://other-private.example/v1", model: "private-upstream-quality", apiKey: "ws-quality-test-key" },
  ]));
  const service = await startServer(readConfig({ NODE_ENV: "test", PI_OFFLINE: "1", DATA_DIR: directory, PORT: "0", NOTIFY_MODE: "off", LLM_MODELS_FILE: file }));
  let socket: WebSocket | undefined;
  try {
    socket = await open(service.origin);
    const rpc = channel(socket);
    const response = await rpc.request("/api/settings/model");
    assert.equal(response.status, 200);
    const before = { models: [{ id: "fast", name: "快速" }, { id: "quality", name: "精准" }], selectedModel: "fast", activeModel: "fast", restartRequired: false };
    assert.deepEqual(response.data, before);
    for (const input of [
      { provider: "openai-completions", baseUrl: "https://injected.example/v1", model: "injected", apiKey: "ws-injected-test-key" },
      { modelId: "quality", provider: "anthropic-messages" }, { modelId: "quality", baseUrl: "https://injected.example/v1" },
      { modelId: "quality", model: "injected" }, { modelId: "quality", apiKey: "ws-injected-test-key" },
      { modelId: "missing" }, { modelId: null }, { modelId: "quality", extra: true }, {},
    ]) {
      const invalid = await rpc.request("/api/settings/model", input);
      assert.equal(invalid.status, 400);
      assert.equal(JSON.stringify(invalid).includes("ws-injected-test-key"), false);
    }
    assert.deepEqual((await rpc.request("/api/settings/model")).data, before);
    const selected = await rpc.request("/api/settings/model", { modelId: "quality" });
    assert.equal(selected.status, 200);
    assert.deepEqual(selected.data, { ...before, selectedModel: "quality", restartRequired: true });
    assert.equal(service.modelLabel, "private-upstream-fast");
    for (const text of [JSON.stringify(response), JSON.stringify(selected)]) {
      for (const privateValue of ["openai-completions", "anthropic-messages", "private-provider.example", "other-private.example", "private-upstream", "ws-fast-test-key", "ws-quality-test-key"]) assert.equal(text.includes(privateValue), false);
    }
  } finally { socket?.terminate(); await service.close(); await rm(directory, { recursive: true, force: true }); }
});

test("WebSocket 握手验证 Basic Auth 与 Origin，非法 JSON 和超大帧被拒绝", { timeout: 20000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-ws-auth-"));
  const server = await startServer(readConfig({ NODE_ENV: "test", PI_OFFLINE: "1", LLM_API: "faux", DATA_DIR: dir, PORT: "0", DEMO_PASSWORD: "test-password", NOTIFY_MODE: "off" }), "127.0.0.1");
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
