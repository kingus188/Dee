import { ATTACHMENT_LIMITS, parseAttachmentsAsync, type TeamsReadResult } from "@assistant/features";
import type { TeamsGraph } from "./teams-graph.js";
import { graphPageUrl } from "./teams-graph.js";
import { boundedBytes } from "./teams-download.js";

type DriveItem = { id: string; name: string; size: number; webUrl: string; file?: { mimeType?: string }; parentReference?: { driveId?: string } };

export async function readTeamsFile({ graph, token, driveId, itemId, fetchImpl, signal }: {
	graph: TeamsGraph; token: string; driveId: string; itemId: string; fetchImpl: typeof fetch; signal?: AbortSignal;
}): Promise<TeamsReadResult> {
	const path = `/drives/${encodeURIComponent(driveId)}/items/${encodeURIComponent(itemId)}`;
	const item = await graph<DriveItem>(token, graphPageUrl(path + "?$select=id,name,size,webUrl,file"));
	if (!item.file || !item.name || !Number.isSafeInteger(item.size) || item.size < 0) throw new Error("Teams 文件信息无效，或目标不是文件");
	if (item.size > ATTACHMENT_LIMITS.totalBytes) throw new Error("文件超过 10MB，请通过原文件链接获取");
	const timeout = signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000);
	const response = await fetchImpl(graphPageUrl(path + "/content"), {
		headers: { Authorization: `Bearer ${token}` }, redirect: "manual", signal: timeout,
	});
	let content = response;
	if (response.status === 302) {
		await response.body?.cancel();
		const location = response.headers.get("location");
		if (!location) throw new Error("Teams 文件下载未返回地址");
		const target = new URL(location);
		// 下载链接自带短期授权，绝不转发 Graph 令牌，也不跟随第二次跳转。
		if (target.protocol !== "https:" || target.username || target.password || (target.port && target.port !== "443")
			|| !["sharepoint.com", "1drv.com", "onedrive.com", "storage.live.com"].some(host => target.hostname.endsWith("." + host))) {
			throw new Error("Teams 文件下载地址不受支持，请使用原文件链接");
		}
		content = await fetchImpl(target.href, { redirect: "error", signal: timeout });
	}
	const bytes = await boundedBytes(content, ATTACHMENT_LIMITS.totalBytes);
	const [attachment] = await parseAttachmentsAsync([{ name: item.name, mimeType: item.file.mimeType ?? "application/octet-stream", data: bytes.toString("base64") }]);
	return { data: { id: item.id, driveId, name: item.name, size: bytes.length, webUrl: item.webUrl }, attachment };
}
