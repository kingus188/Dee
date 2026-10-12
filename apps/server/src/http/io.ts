import type { IncomingMessage, ServerResponse } from "node:http";
import { HttpError } from "../errors.js";
export function sendJson(res: ServerResponse, status: number, body: unknown) {
	const payload = JSON.stringify(body);
	res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
	res.end(payload);
}

export async function readBody(req: IncomingMessage, limit = 100_000): Promise<Record<string, unknown>> {
	const chunks = [];
	let size = 0;
	for await (const chunk of req) {
		size += chunk.length;
		if (size > limit) throw new HttpError(413, "请求太大");
		chunks.push(chunk);
	}
	if (size === 0) return {};
	try {
		const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
		if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new HttpError(400, "请求体必须是 JSON 对象");
		return parsed;
	} catch (error) {
		if (error instanceof HttpError) throw error;
		throw new HttpError(400, "请求不是合法 JSON");
	}
}
