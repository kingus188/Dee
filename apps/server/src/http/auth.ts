import type { IncomingMessage } from "node:http";
import { timingSafeEqual } from "node:crypto";
export function authorized(req: IncomingMessage, password: string) {
	if (!password) return true;
	const header = req.headers.authorization || "";
	if (!header.startsWith("Basic ")) return false;
	const given = Buffer.from(Buffer.from(header.slice(6), "base64").toString("utf8"));
	const expected = Buffer.from(`demo:${password}`);
	return given.length === expected.length && timingSafeEqual(given, expected);
}

// 写操作只接受同源请求，挡住跨站页面借浏览器缓存的口令发请求
export function sameOrigin(req: IncomingMessage) {
	const origin = req.headers.origin;
	if (!origin) return true;
	try {
		return new URL(origin).host === req.headers.host;
	} catch {
		return false;
	}
}

export function secureMatch(given: unknown, expected: unknown) {
  const a = Buffer.from(String(given || ""));
  const b = Buffer.from(String(expected || ""));
  return a.length === b.length && b.length > 0 && timingSafeEqual(a, b);
}
