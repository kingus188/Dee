import type { LookupAddress } from "node:dns";
// 安全抓取公网网页：只连校验过的公网 IP（防 DNS 重绑定），限制大小和总时长，可被取消
import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import http from "node:http";
import https from "node:https";

const MAX_BYTES = 512 * 1024;
const MAX_HOPS = 5;
const TOTAL_TIMEOUT_MS = 15_000;

const blocked = new BlockList();
for (const [net, prefix] of [
	["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16],
	["172.16.0.0", 12], ["192.0.0.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["224.0.0.0", 3],
] as const) blocked.addSubnet(net, prefix, "ipv4");
for (const [net, prefix] of [["::", 128], ["::1", 128], ["64:ff9b::", 96], ["fc00::", 7], ["fe80::", 10], ["ff00::", 8]] as const) {
	blocked.addSubnet(net, prefix, "ipv6");
}
// IPv4 映射段单独放：放进上面的列表会让所有 IPv4 都判成命中（Node BlockList 的行为，已实测）
const mapped = new BlockList();
mapped.addSubnet("::ffff:0:0", 96, "ipv6");

// IPv4 映射地址（::ffff:a.b.c.d）按 IPv4 规则判断，其余按二进制网段判断
function isPublic(address: string) {
	const family = isIP(address);
	if (family === 4) return !blocked.check(address, "ipv4");
	if (family !== 6) return false;
	const dotted = address.toLowerCase().match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
	if (dotted) return !blocked.check(dotted[1], "ipv4");
	// 其他写法的映射地址（如 ::ffff:7f00:1）一律拒绝
	if (mapped.check(address, "ipv6")) return false;
	return !blocked.check(address, "ipv6");
}

async function resolvePublic(hostname: string) {
	const host = hostname.replace(/^\[|\]$/g, "");
	const addresses = isIP(host) ? [{ address: host, family: isIP(host) }] : await lookup(host, { all: true });
	if (addresses.length === 0 || !addresses.every((a) => isPublic(a.address))) throw new Error("不允许访问内网地址");
	return addresses[0];
}

function requestOnce(url: URL, pinned: LookupAddress, signal: AbortSignal) {
	return new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer; truncated: boolean }>((resolve, reject) => {
		const client = url.protocol === "https:" ? https : http;
		const req = client.request(
			url,
			{
				signal,
				headers: { "user-agent": "pi-durable-assistant", accept: "text/html,text/plain;q=0.9,*/*;q=0.5" },
				// 固定使用校验过的地址；Host、SNI 和证书校验仍按原域名
				lookup: (_host, options, callback) =>
					options?.all ? callback(null, [pinned]) : callback(null, pinned.address, pinned.family),
			},
			(res) => {
				const chunks: Buffer[] = [];
				let size = 0;
				res.on("data", (chunk) => {
					size += chunk.length;
					if (size > MAX_BYTES) {
						res.destroy();
						resolve({ status: res.statusCode!,  headers: res.headers, body: Buffer.concat(chunks), truncated: true });
						return;
					}
					chunks.push(chunk);
				});
				res.on("end", () => resolve({ status: res.statusCode!,  headers: res.headers, body: Buffer.concat(chunks), truncated: false }));
				res.on("error", reject);
			},
		);
		req.on("error", reject);
		req.end();
	});
}

export async function fetchPublicPage(rawUrl: string, callerSignal?: AbortSignal) {
	const signal = AbortSignal.any([AbortSignal.timeout(TOTAL_TIMEOUT_MS), ...(callerSignal ? [callerSignal] : [])]);
	let url = new URL(rawUrl);
	for (let hop = 0; hop < MAX_HOPS; hop++) {
		if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("只支持 http 和 https");
		const pinned = await resolvePublic(url.hostname);
		signal.throwIfAborted();
		const response = await requestOnce(url, pinned, signal);
		const location = response.headers.location;
		if (response.status >= 300 && response.status < 400 && location) {
			url = new URL(location, url);
			continue;
		}
		return { status: response.status, text: new TextDecoder().decode(response.body), truncated: response.truncated };
	}
	throw new Error("跳转次数过多");
}
