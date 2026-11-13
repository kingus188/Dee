import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import WebSocket from "ws";
import { attachWebSocket } from "../dist/http/socket.js";
import type { AppContext } from "../dist/application/context.js";
import type { createApi } from "../dist/application/api.js";

test("peer socket authenticates its own channel without granting browser or business API access", { timeout: 10000 }, async () => {
  const server = createServer(), token = randomBytes(32).toString("base64url");
  const context = { config: { password: "", peerToken: token }, redact: String, exitIfFatal: () => {} } as unknown as AppContext;
  const api = { dispatch: async (_method: string, _url: URL, _body: unknown, paired: boolean) => ({ status: paired ? 200 : 401, data: { paired } }) } as unknown as ReturnType<typeof createApi>;
  const closeSockets = attachWebSocket(server, context, api, () => false);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const sockets: WebSocket[] = [];
  async function open(path: string, suppliedOrigin = origin) {
    const ws = new WebSocket(origin.replace("http:", "ws:") + path, { origin: suppliedOrigin, handshakeTimeout: 2000 }); sockets.push(ws);
    await new Promise<void>((resolve, reject) => {
      ws.once("open", resolve); ws.once("error", reject);
      ws.once("unexpected-response", (request, response) => { response.destroy(); request.destroy(); reject(new Error(`WebSocket upgrade returned ${response.statusCode}`)); });
    });
    return ws;
  }
  async function frame(ws: WebSocket, value: unknown) {
    const received = once(ws, "message"); ws.send(JSON.stringify(value));
    return JSON.parse(String((await received)[0]));
  }
  try {
    await assert.rejects(open("/api/socket"), /401/);
    await assert.rejects(open("/api/peers/socket", "https://other.invalid"), /403/);
    const denied = await open("/api/peers/socket"), closed = once(denied, "close");
    denied.send(JSON.stringify({ type: "peer-auth", authorization: "Bearer wrong" })); assert.equal((await closed)[0], 1008);
    const ws = await open("/api/peers/socket");
    assert.deepEqual(await frame(ws, { type: "peer-auth", authorization: `Bearer ${token}` }), { type: "peer-authenticated" });
    assert.equal((await frame(ws, { type: "request", id: "health", method: "GET", path: "/api/info" })).status, 200);
    assert.equal((await frame(ws, { type: "request", id: "business", method: "POST", path: "/api/conversations/direct", body: {} })).status, 403);
  } finally {
    for (const ws of sockets) ws.terminate(); closeSockets();
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
