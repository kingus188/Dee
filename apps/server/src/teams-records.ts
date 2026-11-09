import { teamsRecordsText, teamsPreviewParts, type TeamsChatRecord, type TeamsInboxQuery, type TeamsMessageRow } from "@assistant/features";
import type { TeamsArchive, ArchivedMessage } from "./teams-archive-store.js";

// 只从原消息的 HTML 提取可见文字，不执行或呈现其中的 HTML，不让模型改写记录。
export function teamsOriginalText(message: ArchivedMessage) {
  const body = message.body?.content ?? "";
  if (message.body?.contentType !== "html") return body;
  return body.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?\s*>|<\/(?:p|div|li)>/gi, "\n").replace(/<[^>]*>/g, "")
    .replace(/&(?:nbsp|amp|lt|gt|quot|apos);|&#(?:\d+|x[\da-f]+);/gi, value => {
      const named: Record<string, string> = { "&nbsp;": " ", "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&apos;": "'" };
      if (named[value.toLowerCase()] !== undefined) return named[value.toLowerCase()];
      const point = value.toLowerCase().startsWith("&#x") ? parseInt(value.slice(3, -1), 16) : Number(value.slice(2, -1));
      return Number.isInteger(point) && point > 0 && point <= 0x10ffff && !(point >= 0xd800 && point <= 0xdfff) ? String.fromCodePoint(point) : value;
    }).replace(/\n{3,}/g, "\n\n").trim();
}

export function teamsRecords(archive: TeamsArchive, messages: (ArchivedMessage & { chatId: string })[]): TeamsChatRecord[] {
  return messages.filter(m => m.id && m.chatId && Number.isFinite(Date.parse(m.createdDateTime))).map(message => ({
    chatId: message.chatId, id: message.id, chatLabel: archive.chatLabel(message.chatId),
    sender: message.from?.user?.displayName || "未提供发送人", createdAt: message.createdDateTime,
    direction: archive.messageDirection(message.from?.user?.id),
    text: teamsOriginalText(message), deleted: !!message.deletedDateTime, media: archive.mediaRows(message.chatId, message.id),
  }));
}

export function teamsInboxRecords(archive: TeamsArchive, rows: TeamsMessageRow[]): TeamsChatRecord[] {
  const peers = new Map(rows.filter(row => row.chatId && row.chatType === "oneOnOne" && row.direction === "in").map(row => [row.chatId, row.senderName]));
  return rows.flatMap(row => {
    if (!row.chatId || !row.id?.startsWith(`${row.chatId}:`) || !Number.isFinite(Date.parse(row.createdAt))) return [];
    const id = row.id.slice(row.chatId.length + 1);
    if (!id || !archive.messageReadable(row.chatId, id)) return [];
    const original = archive.message(row.chatId, id);
    const record = original ? teamsRecords(archive, [{ ...original, chatId: row.chatId }])[0] : undefined;
    // 缓存采集与完整归档独立推进，归档尚未到达时展示已采集的正文。
    return [{ ...(record ?? { chatId: row.chatId, id, sender: row.senderName, createdAt: row.createdAt,
      text: row.text, deleted: false, media: row.media ?? [] }),
      chatLabel: row.chatTopic || peers.get(row.chatId) || archive.chatLabel(row.chatId), direction: row.direction }];
  });
}

// 旧会话只从已经返回的原消息 ID 关联归档，不补造未读消息，不修改模型或用户的历史条目。
export function enrichTeamsRecordView(archive: TeamsArchive, name: string, text: string, args?: Record<string, unknown>, legacy?: (query: TeamsInboxQuery) => TeamsMessageRow[]) {
  if (!["teams_history", "teams_archive", "teams_messages"].includes(name)) return text;
  let rows: TeamsMessageRow[] | undefined;
  let cachedRecords: TeamsChatRecord[] | undefined;
  const inboxRows = () => rows ??= legacy?.({ chat: typeof args?.chat === "string" ? args.chat : undefined, sender: typeof args?.sender === "string" ? args.sender : undefined, limit: 5000 }) ?? [];
  if (text.includes("<teams-records>")) return text.replace(/^<teams-records>([^\n]*)<\/teams-records>$/gm, (marker, payload: string) => {
    let records: unknown;
    try { records = JSON.parse(payload); } catch { return marker; }
    if (!Array.isArray(records)) return marker;
    return `<teams-records>${JSON.stringify(records.flatMap(record => {
      if (!record || typeof record.chatId !== "string" || typeof record.id !== "string") return [record];
      if (!archive.messageReadable(record.chatId, record.id)) return [];
      const original = archive.message(record.chatId, record.id);
      if (!original && name === "teams_messages" && legacy) {
        cachedRecords ??= teamsInboxRecords(archive, inboxRows().filter(row => records.some(item => item?.chatId === row.chatId && `${item.chatId}:${item.id}` === row.id)));
        return cachedRecords.filter(row => row.chatId === record.chatId && row.id === record.id);
      }
      return original ? teamsRecords(archive, [{ ...original, chatId: record.chatId }]) : [{ ...record, direction: "unknown" }];
    }))}</teams-records>`;
  });
  if (name === "teams_messages" && legacy) {
    const previews = inboxRows().map(row => ({ row, ...teamsPreviewParts(row) }));
    const matches = new Map<string, TeamsMessageRow[]>();
    for (const line of text.split("\n").filter(line => line.startsWith("["))) {
      const found = previews.filter(parts => line.startsWith(parts.prefix) && line.endsWith(parts.suffix)).map(item => item.row);
      matches.set(line, found);
    }
    const matchedRows: TeamsMessageRow[] = [];
    for (const candidates of matches.values()) {
      if (candidates.length !== 1) return text;
      matchedRows.push(candidates[0]);
    }
    const records = teamsInboxRecords(archive, matchedRows);
    return records.length ? text.replace(/^<teams-media>[^\n]*<\/teams-media>\n?/gm, "") + teamsRecordsText(records) : text;
  }
  for (const line of text.split("\n")) {
    if (!line.startsWith("{")) continue;
    let data: { items?: unknown[]; id?: string; createdDateTime?: string; chatId?: string };
    try { data = JSON.parse(line); } catch { continue; }
    const items = Array.isArray(data.items) ? data.items : data.id ? [data] : [];
    const messages: (ArchivedMessage & { chatId: string })[] = [];
    for (const item of items) {
      if (!item || typeof item !== "object") continue;
      const value = item as ArchivedMessage & { chatId?: string };
      const chatId = typeof args?.chatId === "string" ? args.chatId : value.chatId;
      if (!chatId || typeof value.id !== "string" || !value.id) continue;
      const original = archive.message(chatId, value.id);
      if (original) messages.push({ ...original, chatId });
    }
    const records = teamsRecords(archive, messages);
    if (records.length) return text.replace(/^<teams-media>[^\n]*<\/teams-media>\n?/gm, "") + teamsRecordsText(records);
  }
  return text;
}
