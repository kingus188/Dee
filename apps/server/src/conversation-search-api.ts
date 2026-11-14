import type { ConversationSearchQuery } from "@assistant/contracts";
import type { AppContext } from "./application/context.js";
import { createConversationReader } from "./conversation-reader.js";
import { HttpError } from "./errors.js";

// This endpoint is behind the existing owner HTTP/RPC authentication boundary.
export async function searchConversations(context: AppContext, url: URL) {
  const params = url.searchParams;
  const status = params.get("status") ?? undefined;
  if (status && !["active", "waiting", "completed"].includes(status)) throw new HttpError(400, "对话状态无效");
  if (params.has("archived") && !["true", "false"].includes(params.get("archived")!)) throw new HttpError(400, "归档筛选无效");
  const query: ConversationSearchQuery = { query: params.get("q") ?? "", status: status as ConversationSearchQuery["status"], archived: params.get("archived") === "true", cursor: params.get("cursor") ?? undefined,
    ...(params.has("after") ? { after: Number(params.get("after")) } : {}), ...(params.has("before") ? { before: Number(params.get("before")) } : {}), ...(params.has("limit") ? { limit: Number(params.get("limit")) } : {}) };
  try { return await createConversationReader(context, context.ctx, context.episodeStore).searchOwner(query); }
  catch (error) { if (error instanceof Error && /无效|每页数量/.test(error.message)) throw new HttpError(400, error.message); throw error; }
}

export async function readSearchMessage(context: AppContext, url: URL) {
  const conversationId = Number(url.searchParams.get("conversationId")), entryId = Number(url.searchParams.get("entryId"));
  if (!Number.isSafeInteger(conversationId) || conversationId < 1 || !Number.isSafeInteger(entryId) || entryId < 1 || entryId >= Number.MAX_SAFE_INTEGER) throw new HttpError(400, "消息位置无效");
  const result = await createConversationReader(context, context.ctx, context.episodeStore).readOwner({ conversationId, beforeEntryId: entryId + 1, limit: 1 });
  const message = result.messages.find(message => message.entryId === entryId);
  if (!message) throw new HttpError(404, "消息不存在或不可读取");
  return { conversation: result.conversation, message };
}
