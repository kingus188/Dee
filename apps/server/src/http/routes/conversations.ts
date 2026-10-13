import { openDirectChat } from "../../application/direct-chat.js";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AppContext } from "../../application/context.js";
import { HttpError } from "../../errors.js";
import { readBody, sendJson } from "../io.js";
import type { EntryId } from "@earendil-works/pi-durable";
import { Index } from "@assistant/runtime";
import { createMessages } from "../../application/messages.js";
import type { createConversations } from "../../application/conversations.js";
import type { createEventStream } from "../events.js";
export function createConversationRoutes(context: AppContext, conversations: ReturnType<typeof createConversations>, streamEvents: ReturnType<typeof createEventStream>) {
 const { harness, agentModel, ctx } = context;
 const { getConversation, registerIn, shelveConversation } = conversations;
 const messages = createMessages(context, conversations);
 return async function route(req: IncomingMessage, res: ServerResponse, url: URL) {
 const path = url.pathname, method = req.method;
 if (path === "/api/conversations/direct" && method === "POST") {
   await readBody(req);
   return sendJson(res, 200, { id: await openDirectChat(context) });
 }
	if (path === "/api/conversations") {
		if (method === "GET") {
			const index = await harness.snapshot(Index, ctx);
			return sendJson(res, 200, [...(index?.items ?? [])].reverse());
		}
		if (method === "POST") {
			const conversation = await harness.createConversation(
				{ ownership: { kind: "ownerless" }, agent: { model: agentModel }, init: registerIn({ title: "新对话" }) },
				ctx,
			);
			return sendJson(res, 201, { id: conversation.id });
		}
	}
	const shelf = method === "POST" && path.match(/^\/api\/conversations\/(\d+)\/(archive|restore|remove)$/);
	if (shelf) {
		return sendJson(res, 200, await shelveConversation(Number(shelf[1]), shelf[2]));
	}
	const image = method === "GET" && path.match(/^\/api\/conversations\/(\d+)\/images\/(\d+)\/(\d+)$/);
	if (image) {
		const conversation = await getConversation(Number(image[1]));
		const part = await messages.image(conversation, Number(image[2]) as EntryId, Number(image[3]));
		// 消息写入后不会再变，可以长期缓存；nosniff 防止浏览器把它当成别的类型执行
		res.writeHead(200, {
			"content-type": part.mimeType,
			"cache-control": "private, max-age=31536000, immutable",
			"x-content-type-options": "nosniff",
		});
		return res.end(Buffer.from(part.data, "base64"));
	}
	const match = path.match(/^\/api\/conversations\/(\d+)\/(events|messages|fork|abort)$/);
	if (match) {
		const conversation = await getConversation(Number(match[1]));
		const action = match[2];
		if (method === "GET" && action === "events") return streamEvents(req, res, conversation);
		if (method === "POST" && action === "messages") {
			// 附件以 base64 放在 JSON 里，10MB 附件编码后约 13.4MB
			const body = await readBody(req, 14_000_000);
			return sendJson(res, 202, await messages.submit(conversation, body));
		}
		if (method === "POST" && action === "fork") {
			const body = await readBody(req);
			return sendJson(res, 201, await messages.fork(conversation, body));
		}
		if (method === "POST" && action === "abort") {
			await conversation.abort(ctx);
			return sendJson(res, 200, { ok: true });
		}
	}
	throw new HttpError(404, "接口不存在");
}
;
}
