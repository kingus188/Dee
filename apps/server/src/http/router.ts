import type { IncomingMessage, ServerResponse } from "node:http";
import { Meta } from "@assistant/runtime";
import type { AppContext } from "../application/context.js";
import { createConversations } from "../application/conversations.js";
import { createViews } from "../application/views.js";
import { HttpError } from "../errors.js";
import { sameOrigin } from "./auth.js";
import { sendJson } from "./io.js";
import { createStaticHandler } from "./static.js";
import { createEventStream } from "./events.js";
import { createConversationRoutes } from "./routes/conversations.js";
import { createTaskRoutes } from "./routes/tasks.js";
import { createPersonalRoutes } from "./routes/personal.js";
export function createRouter(context: AppContext, webRoot: URL) {
 const { config, wechat, harness, ctx, modelLabel, startedAt } = context;
 const conversations = createConversations(context), views = createViews(context);
 const staticFile = createStaticHandler(webRoot);
 const conversationRoute = createConversationRoutes(context, conversations, createEventStream(context, views));
 const taskRoute = createTaskRoutes(context, conversations, views), personalRoute = createPersonalRoutes(context);
 return async (req: IncomingMessage, res: ServerResponse) => {
   const url = new URL(req.url!, "http://localhost"), path = url.pathname, method = req.method;
   if (method !== "GET" && !sameOrigin(req)) throw new HttpError(403, "只接受同源请求");
   if (method === "GET" && await staticFile(path, res)) return;
   if (method === "GET" && path === "/api/wechat/status") return sendJson(res, 200, wechat ? await wechat.status() : { enabled: false });
   if (path.startsWith("/api/personal") || path.startsWith("/api/knowledge/")) return personalRoute(req, res, url);
   if (method === "GET" && path === "/api/info") {
     const meta = await harness.snapshot(Meta, ctx);
     return sendJson(res, 200, { model: modelLabel, api: config.model.api, pid: process.pid, startedAt, boots: meta?.boots ?? 0 });
   }
   if (method === "POST" && path === "/api/crash") {
     if (config.production && !config.enableCrashDemo) throw new HttpError(403, "生产环境已禁用模拟崩溃");
     sendJson(res, 200, { ok: true });
     console.log("收到模拟崩溃请求，200ms 后退出");
     setTimeout(() => process.exit(1), 200);
     return;
   }
   const manage = path.match(/^\/api\/conversations\/(\d+)\/(management|export\.md|schedules|background|reminders)(?:\/([0-9a-f-]+))?(?:\/(pause|resume|cancel|stop))?$/);
   if (manage) return taskRoute(req, res, manage);
   return conversationRoute(req, res, url);
 };
}
