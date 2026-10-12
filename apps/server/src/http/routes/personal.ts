import type { IncomingMessage, ServerResponse } from "node:http";
import type { AppContext } from "../../application/context.js";
import { createPersonalService } from "../../application/personal.js";
import { personalError } from "@assistant/features";
import { HttpError } from "../../errors.js";
import { readBody, sendJson } from "../io.js";
export function createPersonalRoutes(context: AppContext) {
 const service = createPersonalService(context);
 return async (req: IncomingMessage, res: ServerResponse, url: URL) => {
   const path = url.pathname;
   try {
     if (req.method === "GET" && path === "/api/personal") return sendJson(res, 200, await service.get());
     if (req.method === "GET" && path === "/api/knowledge/search") return sendJson(res, 200, await service.search(url.searchParams.get("q") || "", url.searchParams.get("history") === "1"));
     if (req.method === "GET" && path === "/api/knowledge/read") return sendJson(res, 200, await service.read(url.searchParams.get("path") || "", Number(url.searchParams.get("line") || 1)));
     const personal = path.match(/^\/api\/personal\/(memory|skills)(?:\/([0-9a-f-]+)\/(approve|reject))?$/);
     if (personal && req.method === "POST") {
       const [, kind, id, action] = personal;
       const item = await service.save(kind, id ? {} : await readBody(req), id, action);
       return sendJson(res, id ? 200 : 201, { item });
     }
   } catch (error) {
     if (personalError(error)) throw new HttpError(400, error.message);
     throw error;
   }
   throw new HttpError(404, "接口不存在");
 };
}
