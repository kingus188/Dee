import type { TeamsConversation, TeamsConversationList, TeamsConversationMessage, TeamsConversationMessages } from "@assistant/contracts";
import type { AppContext } from "./application/context.js";
import type { ArchivedMessage } from "./teams-archive-store.js";
import { HttpError } from "./errors.js";
import { graphPageUrl } from "./teams-graph.js";
import { messageText } from "./teams-message-text.js";
import { teamsOriginalText } from "./teams-records.js";
import { safeTeamsSourceUrl } from "./teams-triage-store.js";

type Context = Pick<AppContext, "config" | "teamsStore" | "teamsSender">;
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const timestamp = (value: unknown): value is string => typeof value === "string" && Number.isFinite(Date.parse(value));
const id = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 1024 && !/[\u0000-\u001f]/.test(value) && value !== "." && value !== "..";
const text = (value: unknown) => typeof value === "string" ? value : "";
function page(value: unknown, path: string, previous?: string) {
  if (!record(value) || !Array.isArray(value.items) || !(value.nextCursor === null || typeof value.nextCursor === "string")) throw new HttpError(502, "Teams 返回的数据格式不完整，请重新读取");
  if (value.nextCursor) {
    if (value.nextCursor.length > 16_384) throw new HttpError(502, "Teams 返回的分页地址过长，请重新读取");
    try { graphPageUrl(path, value.nextCursor); } catch { throw new HttpError(502, "Teams 返回的分页地址无效，请重新读取"); }
    if (value.nextCursor === previous) throw new HttpError(502, "Teams 分页未推进，请从第一页重新读取");
  }
  return { items: value.items as unknown[], nextCursor: value.nextCursor as string | null, currentUserId: typeof value.currentUserId === "string" ? value.currentUserId : undefined };
}
function mapError(error: unknown): never {
  if (error instanceof HttpError) throw error;
  const status = record(error) ? error.status : undefined;
  if (status === 401 || status === 403 || status === 404) throw new HttpError(status, (error as Error).message);
  const message = error instanceof Error ? error.message : "";
  if (/分页地址|资源标识/.test(message)) throw new HttpError(400, "Teams 分页或会话标识无效，请从第一页重新读取");
  // Do not return arbitrary provider responses or credentials to the browser.
  if (/登录|账号|授权|权限|访问权/.test(message)) throw new HttpError(403, "无法读取 Teams，请检查当前账号登录和聊天访问权限");
  throw new HttpError(503, "Teams 暂时读取失败，请稍后重试；没有将失败当作空结果或显示旧缓存");
}

export async function teamsConversationsApi(context: Context, method: string, url: URL) {
  if (method !== "GET" || !["/api/teams/conversations", "/api/teams/conversations/messages"].includes(url.pathname)) return;
  const { teamsSender: sender, teamsStore: store } = context;
  const available = !context.config.offline && !!sender.read;
  const fetchedAt = new Date().toISOString();
  const cursor = url.searchParams.get("cursor") || undefined;
  if (cursor && cursor.length > 16_384) throw new HttpError(400, "Teams 分页地址过长，请从第一页重新读取");
  if (url.pathname === "/api/teams/conversations") {
    if (!available) return { status: 200, data: { available: false, canSend: false, items: [], nextCursor: null, fetchedAt } satisfies TeamsConversationList };
    const path = "/me/chats?$expand=members&$top=50";
    try {
      if (cursor) graphPageUrl(path, cursor);
      const result = page((await sender.read!({ kind: "chats", cursor })).data, path, cursor);
      const items: TeamsConversation[] = result.items.map(value => {
        if (!record(value) || !id(value.id)) throw new HttpError(502, "Teams 会话标识缺失，请重新读取");
        const members = Array.isArray(value.members) ? value.members.filter(record) : [];
        const peers = members.filter(member => !result.currentUserId || member.userId !== result.currentUserId);
        const title = text(value.topic).trim() || peers.map(member => text(member.displayName)).filter(Boolean).join("、") || "未命名会话";
        const preview = record(value.lastMessagePreview) && !value.lastMessagePreview.deletedDateTime && (!id(value.lastMessagePreview.id) || store.sourceAllowed(`teams:${value.id}`, undefined, [`${value.id}:${value.lastMessagePreview.id}`])) && record(value.lastMessagePreview.body)
          ? teamsOriginalText({ body: value.lastMessagePreview.body } as ArchivedMessage).slice(0, 160) : undefined;
        return { id: value.id, title, kind: ["oneOnOne", "group", "meeting"].includes(String(value.chatType)) ? value.chatType as TeamsConversation["kind"] : "unknown",
          ...(timestamp(value.lastUpdatedDateTime) ? { updatedAt: value.lastUpdatedDateTime } : {}),
          ...(preview ? { preview } : {}), sourceUrl: safeTeamsSourceUrl(value.webUrl) };
      }).filter(item => store.sourceAllowed(`teams:${item.id}`));
      return { status: 200, data: { available: true, canSend: !!sender.send, items, nextCursor: result.nextCursor, fetchedAt } satisfies TeamsConversationList };
    } catch (error) { mapError(error); }
  }
  if (!available) throw new HttpError(503, "Teams 在线读取未连接，请先连接账号");
  const chatId = url.searchParams.get("chatId");
  if (!id(chatId)) throw new HttpError(400, "Teams 会话标识无效");
  if (!store.sourceAllowed(`teams:${chatId}`)) throw new HttpError(403, "此 Teams 来源已不可用，无法显示聊天记录");
  const accessGeneration = store.triage.accessGeneration(chatId);
  const path = `/chats/${encodeURIComponent(chatId)}/messages?$top=50&$orderby=createdDateTime desc`;
  try {
    if (cursor) graphPageUrl(path, cursor);
    // Every page is fetched online. A configured reader or local archive is not
    // proof of present access, and failed reads never fall back to cached text.
    const result = page((await sender.read!({ kind: "history", chatId, cursor, downloadMedia: false })).data, path, cursor);
    if (!store.sourceAllowed(`teams:${chatId}`)) throw new HttpError(403, "此 Teams 来源已不可用，无法显示聊天记录");
    if (!store.triage.access(chatId, true, accessGeneration)) throw new HttpError(409, "Teams 访问状态已变化，旧读取结果已隐藏，请重新读取");
    const suggestions = new Map(store.triage.list().items.filter(item => item.chatId === chatId).map(item => [item.id, item]));
    const items: TeamsConversationMessage[] = result.items.map(value => {
      if (!record(value) || !id(value.id) || !timestamp(value.createdDateTime)) throw new HttpError(502, "Teams 消息标识或时间缺失，请重新读取");
      const sourceId = `${chatId}:${value.id}`, deleted = !!value.deletedDateTime;
      const unavailable = !store.sourceAllowed(`teams:${chatId}`, undefined, [sourceId]);
      if (deleted || unavailable) return { id: value.id, chatId, createdAt: value.createdDateTime, senderName: "", direction: "unknown", text: "", deleted, unavailable, media: [] };
      const original = value as ArchivedMessage, user = original.from?.user;
      const stored = store.message(sourceId), suggestion = suggestions.get(sourceId);
      const direction = user?.id && result.currentUserId ? user.id === result.currentUserId ? "out" : "in" : stored?.direction ?? "unknown";
      return { id: value.id, chatId, senderName: user?.displayName || original.from?.application?.displayName || "发送者未提供", direction,
        createdAt: value.createdDateTime, ...(timestamp(value.lastModifiedDateTime) && value.lastModifiedDateTime !== value.createdDateTime ? { modifiedAt: value.lastModifiedDateTime } : {}),
        text: teamsOriginalText(original), deleted: false, unavailable: false, sourceUrl: safeTeamsSourceUrl(value.webUrl),
        media: store.archive.mediaRows(chatId, value.id),
        ...(suggestion && stored?.text === messageText(original) && store.sourceAllowed(`teams:${chatId}`, suggestion.revision, [sourceId]) ? { suggestion } : {}) };
    });
    items.sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt) || a.id.localeCompare(b.id));
    return { status: 200, data: { chatId, items, nextCursor: result.nextCursor, fetchedAt } satisfies TeamsConversationMessages };
  } catch (error) {
    // A definite access loss closes previously issued media URLs too. This is
    // reversible on a successful online read, unlike a deletion tombstone.
    if (record(error) && (error.status === 403 || error.status === 404)) store.triage.access(chatId, false);
    mapError(error);
  }
}
