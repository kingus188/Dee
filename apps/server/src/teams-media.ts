import { parseAttachments, type TeamsReadResult } from "@assistant/features";
import type { TeamsArchive, ArchivedMessage } from "./teams-archive-store.js";
import { graphPageUrl, type TeamsGraph } from "./teams-graph.js";
import { boundedBytes } from "./teams-download.js";

export function readArchivedMedia(archive: TeamsArchive, id: string): TeamsReadResult {
  const item = archive.media(id);
  if (!item?.bytes || !item.mime || item.status !== "ready") throw new Error("截图尚未保存或无法读取，请查询归档同步状态");
  const [attachment] = parseAttachments([{ name: item.name, mimeType: item.mime, data: Buffer.from(item.bytes).toString("base64") }]);
  return { data: { id, name: item.name, previewUrl: `/api/teams/media/${id}` }, attachment };
}

export function createTeamsMedia({ archive, graph, getToken, fetchImpl = fetch, signal }: {
  archive: TeamsArchive; graph: TeamsGraph; getToken: () => Promise<string>; fetchImpl?: typeof fetch; signal?: AbortSignal;
}) {
  const base = (chatId: string, messageId: string) => `/chats/${encodeURIComponent(chatId)}/messages/${encodeURIComponent(messageId)}/hostedContents`;
  return {
    async discover(chatId: string, messages: ArchivedMessage[], token: string) {
      for (const message of messages) {
        if (!/<img\b/i.test(message.body?.content ?? "")) continue;
        try {
          const data = await graph<{ value: { id: string }[] }>(token, graphPageUrl(base(chatId, message.id)));
          if (!Array.isArray(data.value) || data.value.some(item => !item.id)) throw new Error("Teams 截图列表格式无效");
          archive.hosted(chatId, message.id, data.value.map(item => item.id));
        } catch {
          signal?.throwIfAborted();
          archive.hostedFailure(chatId, message.id);
        }
      }
    },
    async download(limit = 8) {
      const pending = archive.pendingMedia(limit);
      if (!pending.length) return;
      const token = await getToken();
      for (const item of pending) {
        signal?.throwIfAborted();
        try {
          const url = graphPageUrl(base(item.chat_id, item.message_id) + `/${encodeURIComponent(item.source)}/$value`);
          const response = await fetchImpl(url, { headers: { Authorization: `Bearer ${token}` }, redirect: "error", signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000) });
          const mime = response.headers.get("content-type")?.split(";")[0] ?? "";
          const bytes = await boundedBytes(response, 5 * 1024 * 1024);
          parseAttachments([{ name: "screenshot", mimeType: mime, data: bytes.toString("base64") }]);
          archive.saveBytes(item.id, mime, bytes);
        } catch (error) {
          signal?.throwIfAborted();
          archive.mediaFailure(item.id, error instanceof Error && /上限/.test(error.message) ? "截图超过保存上限" : "截图保存失败，等待重试或检查权限");
        }
      }
    },
    read(id: string): TeamsReadResult {
      return readArchivedMedia(archive, id);
    },
  };
}
