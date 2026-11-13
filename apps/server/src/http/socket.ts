import type { IncomingMessage, Server } from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import type { ApiRequest, ServerMessage } from "@assistant/contracts";
import type { AppContext } from "../application/context.js";
import type { createApi } from "../application/api.js";
import { watchView } from "../application/view-stream.js";
import { HttpError } from "../errors.js";
import { sameOrigin, secureMatch } from "./auth.js";
import { watchPeerTasks } from "./peer-stream.js";

export function attachWebSocket(server: Server, context: AppContext, api: ReturnType<typeof createApi>, isAuthorized: (req: IncomingMessage) => boolean) {
  const sockets = new WebSocketServer({ noServer: true, maxPayload: 14 * 1024 * 1024, perMessageDeflate: false });
  const peerSockets = new WebSocketServer({ noServer: true, maxPayload: 24 * 1024 * 1024, perMessageDeflate: false });
  server.on("upgrade", (req, socket, head) => {
    const peer = req.url === "/api/peers/socket";
    const status = !peer && req.url !== "/api/socket" ? 404 : !peer && !isAuthorized(req) ? 401 : !sameOrigin(req) ? 403 : 0;
    if (status) {
      socket.end(`HTTP/1.1 ${status} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
      return;
    }
    const target = peer ? peerSockets : sockets;
    target.handleUpgrade(req, socket, head, ws => target.emit("connection", ws, req));
  });
  const connected = (ws: WebSocket, req: IncomingMessage) => {
    const peer = req.url === "/api/peers/socket";
    let authenticated = !peer;
    let alive = true, sequence = 0;
    let stream: ReturnType<typeof watchView> | undefined;
    let stopPeer: (() => void) | undefined, peerDevice: string | undefined;
    const pending = new Set<string>();
    function send(message: ServerMessage | { type: "peer-authenticated" }) {
      return new Promise<void>((resolve, reject) => {
        if (ws.readyState !== WebSocket.OPEN) return reject(new Error("连接已关闭"));
        if (ws.bufferedAmount > 16 * 1024 * 1024) { ws.terminate(); return reject(new Error("客户端读取过慢")); }
        ws.send(JSON.stringify(message), error => error ? reject(error) : resolve());
      });
    }
    const heartbeat = setInterval(() => {
      if (!alive) return ws.terminate();
      alive = false; ws.ping();
    }, 15_000);
    const authTimeout = peer ? setTimeout(() => ws.close(1008, "设备认证超时"), 10000) : undefined;
    ws.on("pong", () => { alive = true; });
    ws.on("close", () => { sequence++; clearInterval(heartbeat); clearTimeout(authTimeout); stream?.close(); stopPeer?.(); });
    ws.on("error", error => { console.warn("WebSocket 连接失败：", context.redact(error.message)); if (ws.readyState !== WebSocket.CLOSING) ws.terminate(); });
    ws.on("message", async (data, binary) => {
      let request: ApiRequest | undefined;
      let registered = false;
      try {
        if (!authenticated && (binary || Buffer.byteLength(data.toString()) > 8192)) { ws.close(1008, "设备认证无效"); return; }
        const text = data.toString();
        const input = JSON.parse(text);
        if (!authenticated) {
          const header = input?.authorization, config = context.config;
          const accepted = input?.type === "peer-auth" && typeof header === "string" && (
            (!!config.peerToken && secureMatch(header, `Bearer ${config.peerToken}`)) ||
            (!!config.password && secureMatch(header, "Basic " + Buffer.from(`demo:${config.password}`).toString("base64")))
          );
          if (!accepted) { ws.close(1008, "设备认证失败"); return; }
          authenticated = true; clearTimeout(authTimeout); await send({ type: "peer-authenticated" }); return;
        }
        if (binary || !input || input.type !== "request" || typeof input.id !== "string" || !input.id || input.id.length > 100 ||
          !["GET", "POST"].includes(input.method) || typeof input.path !== "string" || !input.path.startsWith("/api/") || input.path.length > (input.method === "GET" && /^\/api\/teams\/conversations(?:\/messages)?\?/.test(input.path) ? 64_000 : 4000) ||
          (input.body !== undefined && (!input.body || typeof input.body !== "object" || Array.isArray(input.body)))) throw new HttpError(400, "请求格式不合法");
        request = input;
        if (pending.has(input.id)) throw new HttpError(409, "请求正在处理");
        if (pending.size >= 16) throw new HttpError(429, "请求过多，请稍后重试");
        const url = new URL(input.path, "http://localhost");
        if (peer && !(url.pathname.startsWith("/api/peers/") || (input.method === "GET" && url.pathname === "/api/info"))) throw new HttpError(403, "设备连接只允许双端协作接口");
        // notes carries both the new content and base, matching the bounded HTTP allowance.
        const limit = peer && input.method === "POST" && url.pathname === "/api/peers/conversations" ? 24 * 1024 * 1024
          : input.method === "POST" && (url.pathname === "/api/notes" || /^\/api\/conversations\/\d+\/notes$/.test(url.pathname)) ? 2_000_000 : 100_000;
        if (!/^\/api\/conversations\/\d+\/messages$/.test(url.pathname) && url.pathname !== "/api/daylight/tasks/save" && Buffer.byteLength(text) > limit) throw new HttpError(413, "请求太大");
        pending.add(input.id);
        registered = true;
        const subscription = input.method === "GET" && url.pathname.match(/^\/api\/conversations\/(\d+)\/events$/);
        if (subscription) {
          const version = ++sequence;
          stream?.close();
          const conversation = await api.conversations.getConversation(Number(subscription[1]));
          if (ws.readyState !== WebSocket.OPEN) return;
          if (version !== sequence) throw new HttpError(409, "订阅已被新的会话替换");
          stream = watchView(context, api.views, conversation, view => send({ type: "event", event: "view", data: view }), error => {
            console.error("推送失败：", context.redact(error instanceof Error ? error.message : error));
            context.exitIfFatal(error); ws.close(1011, "实时状态读取失败");
          });
          await stream.ready;
          await send({ type: "response", id: input.id, status: 200, data: { ok: true } });
        } else {
          const result = await api.dispatch(input.method, url, input.body, peer);
          if (peer && input.method === "GET" && url.pathname === "/api/peers/tasks") {
            const deviceId = url.searchParams.get("deviceId")!;
            if (peerDevice !== deviceId) {
              const version = ++sequence; stopPeer?.(); stopPeer = undefined; peerDevice = deviceId;
              const stop = await watchPeerTasks(context, deviceId, event => version === sequence && ws.readyState === WebSocket.OPEN ? send(event) : Promise.resolve(), error => { context.exitIfFatal(error); ws.close(1011, "双端状态读取失败"); })
                .catch(error => { if (version === sequence) peerDevice = undefined; throw error; });
              if (version !== sequence || ws.readyState !== WebSocket.OPEN) stop(); else stopPeer = stop;
            }
          }
          await send({ type: "response", id: input.id, ...result });
        }
      } catch (error) {
        const status = error instanceof HttpError ? error.status : error instanceof SyntaxError ? 400 : 500;
        if (status === 500) console.error("WebSocket 请求失败：", context.redact(error instanceof Error ? error.message : error));
        if (request && ws.readyState === WebSocket.OPEN) {
          try { await send({ type: "response", id: request.id, status, error: error instanceof HttpError ? error.message : status === 400 ? "请求不是合法 JSON" : "服务器出错，详情见服务器日志" }); }
          catch { ws.terminate(); }
        } else if (ws.readyState === WebSocket.OPEN) ws.close(1008, "请求格式不合法");
        context.exitIfFatal(error);
      } finally { if (registered && request) pending.delete(request.id); }
    });
  };
  sockets.on("connection", connected); peerSockets.on("connection", connected);
  return () => { for (const server of [sockets, peerSockets]) { for (const ws of server.clients) ws.terminate(); server.close(); } };
}
