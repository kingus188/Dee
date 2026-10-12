import type { IncomingMessage, ServerResponse } from "node:http";
import type { AppContext } from "../../application/context.js";
import { HttpError } from "../../errors.js";
import { readBody, sendJson } from "../io.js";
import type { createConversations } from "../../application/conversations.js";
import type { createViews } from "../../application/views.js";
import { createManagement } from "../../application/management.js";

export function createTaskRoutes(context: AppContext, { getConversation }: ReturnType<typeof createConversations>, views: ReturnType<typeof createViews>) {
 const tasks = createManagement(context, views);
 return async function route(req: IncomingMessage, res: ServerResponse, match: RegExpMatchArray) {
   const conversation = await getConversation(Number(match[1]));
   const [, , resource, itemId, action] = match;
   if (req.method === "GET" && resource === "management" && !itemId) return sendJson(res, 200, await tasks.get(conversation));
   if (req.method === "GET" && resource === "export.md" && !itemId) {
     const md = await tasks.exportMarkdown(conversation);
     res.writeHead(200, { "content-type": "text/markdown; charset=utf-8", "content-disposition": 'attachment; filename="conversation-' + conversation.id + '.md"', "cache-control": "no-store" });
     return res.end(md);
   }
   if (req.method === "POST") {
     try {
       if (resource === "schedules" && !itemId) return sendJson(res, 201, { item: await tasks.schedule(conversation, await readBody(req)) });
       if (resource === "schedules" && itemId && ["pause", "resume", "cancel"].includes(action)) return sendJson(res, 200, { item: await tasks.manageSchedule(conversation, itemId, action) });
       if (resource === "reminders" && itemId && action === "cancel") return sendJson(res, 200, { item: await tasks.cancelReminder(conversation, itemId) });
       if (resource === "background" && !itemId) return sendJson(res, 201, { item: await tasks.background(conversation, await readBody(req)) });
       if (resource === "background" && itemId && action === "stop") return sendJson(res, 200, { item: await tasks.stopBackground(conversation, itemId) });
     } catch (error) {
       if (error instanceof Error && /任务内容|首次执行|重复间隔|requestId|计划任务不存在|当前状态|后台任务说明/.test(error.message)) throw new HttpError(400, error.message);
       throw error;
     }
   }
   throw new HttpError(404, "接口不存在");
 };
}
