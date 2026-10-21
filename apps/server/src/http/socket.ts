import type { Server } from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import type { ApiRequest, ServerMessage } from "@assistant/contracts";
import type { AppContext } from "../application/context.js";
import type { createApi } from "../application/api.js";
import { watchView } from "../application/view-stream.js";
import { HttpError } from "../errors.js";
import { authorized, sameOrigin } from "./auth.js";

export function attachWebSocket(server: Server, context: AppContext, api: ReturnType<typeof createApi>) {
  const sockets = new WebSocketServer({ noServer: true, maxPayload: 14 * 1024 * 1024, perMessageDeflate: false });
  server.on("upgrade", (req, socket, head) => {
    const status = req.url !== "/api/socket" ? 404 : !authorized(req, context.config.password) ? 401 : !sameOrigin(req) ? 403 : 0;
    if (status) {
      socket.end(`HTTP/1.1 ${status} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
      return;
    }
    sockets.handleUpgrade(req, socket, head, ws => sockets.emit("connection", ws));
  });
  sockets.on("connection", ws => {
    let alive = true, sequence = 0;
    let stream: ReturnType<typeof watchView> | undefined;
    const pending = new Set<string>();
    function send(message: ServerMessage) {
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
    ws.on("pong", () => { alive = true; });
    ws.on("close", () => { sequence++; clearInterval(heartbeat); stream?.close(); });
    ws.on("error", error => { console.warn("WebSocket 连接失败：", context.redact(error.message)); if (ws.readyState !== WebSocket.CLOSING) ws.terminate(); });
    ws.on("message", async (data, binary) => {
      let request: ApiRequest | undefined;
      let registered = false;
      try {
        const text = data.toString();
        const input = JSON.parse(text);
        if (binary || !input || input.type !== "request" || typeof input.id !== "string" || !input.id || input.id.length > 100 ||
          !["GET", "POST"].includes(input.method) || typeof input.path !== "string" || !input.path.startsWith("/api/") || input.path.length > 4000 ||
          (input.body !== undefined && (!input.body || typeof input.body !== "object" || Array.isArray(input.body)))) throw new HttpError(400, "请求格式不合法");
        request = input;
        if (pending.has(input.id)) throw new HttpError(409, "请求正在处理");
        if (pending.size >= 16) throw new HttpError(429, "请求过多，请稍后重试");
        const url = new URL(input.path, "http://localhost");
        if (!/^\/api\/conversations\/\d+\/messages$/.test(url.pathname) && url.pathname !== "/api/daylight/tasks/save" && Buffer.byteLength(text) > 100_000) throw new HttpError(413, "请求太大");
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
          const result = await api.dispatch(input.method, url, input.body);
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
  });
  return () => { for (const ws of sockets.clients) ws.terminate(); sockets.close(); };
}
