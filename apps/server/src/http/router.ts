import type { IncomingMessage, ServerResponse } from "node:http";
import type { EntryId } from "@earendil-works/pi-durable";
import type { AppContext } from "../application/context.js";
import { createApi } from "../application/api.js";
import { HttpError } from "../errors.js";
import { sameOrigin } from "./auth.js";
import { readBody, sendJson } from "./io.js";
import { createEventStream } from "./events.js";

export function createRouter(context: AppContext, api = createApi(context)) {
  const events = createEventStream(context, api.views);
  return async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url!, "http://localhost"), path = url.pathname, method = req.method!;
    if (method !== "GET" && !sameOrigin(req)) throw new HttpError(403, "只接受同源请求");
    if (method === "GET") {
      const stream = path.match(/^\/api\/conversations\/(\d+)\/events$/);
      if (stream) return events(req, res, await api.conversations.getConversation(Number(stream[1])));
      const image = path.match(/^\/api\/conversations\/(\d+)\/images\/(\d+)\/(\d+)$/);
      if (image) {
        const part = await api.messages.image(await api.conversations.getConversation(Number(image[1])), Number(image[2]) as EntryId, Number(image[3]));
        res.writeHead(200, { "content-type": part.mimeType, "cache-control": "private, max-age=31536000, immutable", "x-content-type-options": "nosniff" });
        return res.end(Buffer.from(part.data, "base64"));
      }
      const exported = path.match(/^\/api\/conversations\/(\d+)\/export\.md$/);
      if (exported) {
        const md = await api.tasks.exportMarkdown(await api.conversations.getConversation(Number(exported[1])));
        res.writeHead(200, { "content-type": "text/markdown; charset=utf-8", "content-disposition": `attachment; filename="conversation-${exported[1]}.md"`, "cache-control": "no-store" });
        return res.end(md);
      }
    }
    // notes 同时携带新正文和 base；两份 128000 字正文加 JSON 转义仍有明确上限。
    const bodyLimit = /^\/api\/conversations\/\d+\/messages$/.test(path) || path === "/api/daylight/tasks/save" ? 14_000_000
      : /^\/api\/conversations\/\d+\/notes$/.test(path) ? 2_000_000 : 100_000;
    const body = method === "POST" ? await readBody(req, bodyLimit) : {};
    const result = await api.dispatch(method, url, body);
    sendJson(res, result.status, result.data);
  };
}
