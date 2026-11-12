import type { TeamsConversationList, TeamsConversationMessage, TeamsConversationMessages } from "@assistant/contracts";
import { teamsSourceUrl } from "./data.js";

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const timestamp = (value: unknown): value is string => typeof value === "string" && Number.isFinite(Date.parse(value));
const string = (value: unknown): value is string => typeof value === "string";
const optional = (value: unknown) => value === undefined || string(value);
const page = (value: Record<string, unknown>) => timestamp(value.fetchedAt) && (value.nextCursor === null || (string(value.nextCursor) && !!value.nextCursor));
const mediaPath = /^\/api\/teams\/media\/[a-f0-9]{64}$/;
export function safeTeamsAttachment(value?: string) {
  if (!value) return;
  if (mediaPath.test(value)) return value;
  try { const url = new URL(value); return url.protocol === "https:" && !url.username && !url.password ? url.href : undefined; } catch { return; }
}
export function isTeamsConversationList(value: unknown): value is TeamsConversationList {
  return record(value) && page(value) && typeof value.available === "boolean" && (value.canSend === undefined || typeof value.canSend === "boolean") && Array.isArray(value.items) && value.items.every(item => record(item) && string(item.id) && !!item.id && string(item.title) &&
    ["oneOnOne", "group", "meeting", "unknown"].includes(String(item.kind)) && (item.updatedAt === undefined || timestamp(item.updatedAt)) && optional(item.preview) && optional(item.sourceUrl));
}
function isMessage(value: unknown): value is TeamsConversationMessage {
  if (!record(value) || !["id", "chatId", "senderName", "text"].every(key => string(value[key])) || !value.id || !value.chatId || !timestamp(value.createdAt) ||
    !(value.modifiedAt === undefined || timestamp(value.modifiedAt)) || !["in", "out", "unknown"].includes(String(value.direction)) ||
    typeof value.deleted !== "boolean" || typeof value.unavailable !== "boolean" || !optional(value.sourceUrl) || !Array.isArray(value.media)) return false;
  if (!value.media.every(item => record(item) && ["id", "name", "status"].every(key => string(item[key])) && /^[a-f0-9]{64}$/.test(String(item.id)) && ["image", "file"].includes(String(item.kind)) && optional(item.url) && optional(item.previewUrl))) return false;
  const item = value.suggestion;
  return item === undefined || record(item) && ["id", "chatId", "chatLabel", "senderName", "text", "reason", "uncertainty", "suggestedTitle"].every(key => string(item[key])) &&
    item.chatId === value.chatId && item.id === `${value.chatId}:${value.id}` && Number.isSafeInteger(item.revision) && Number(item.revision) >= 0 && timestamp(item.createdAt) &&
    ["now", "later", "unclear"].includes(String(item.attention)) && typeof item.suggestTodo === "boolean" && optional(item.sourceUrl);
}
export function isTeamsConversationMessages(value: unknown): value is TeamsConversationMessages {
  return record(value) && page(value) && string(value.chatId) && !!value.chatId && Array.isArray(value.items) && value.items.every(item => isMessage(item) && item.chatId === value.chatId);
}
export function mergeTeamsMessages(previous: TeamsConversationMessage[], incoming: TeamsConversationMessage[]) {
  const items = new Map(previous.map(item => [item.id, item]));
  for (const item of incoming) {
    const old = items.get(item.id);
    // A paged snapshot cannot restore a deletion or overwrite an observed edit
    // with an older duplicate from a shifting Graph page.
    if (old && (old.deleted || old.unavailable) && !item.deleted && !item.unavailable) continue;
    if (old && !item.deleted && !item.unavailable && Date.parse(old.modifiedAt ?? old.createdAt) > Date.parse(item.modifiedAt ?? item.createdAt)) continue;
    items.set(item.id, item);
  }
  return [...items.values()].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt) || a.id.localeCompare(b.id));
}
export function sanitizeTeamsMessage(item: TeamsConversationMessage): TeamsConversationMessage {
  if (item.deleted || item.unavailable) return { ...item, text: "", senderName: "", media: [], sourceUrl: undefined, suggestion: undefined };
  return { ...item, sourceUrl: teamsSourceUrl(item.sourceUrl), media: item.media.map(media => ({ ...media, url: safeTeamsAttachment(media.url), previewUrl: media.previewUrl && mediaPath.test(media.previewUrl) ? media.previewUrl : undefined })) };
}
