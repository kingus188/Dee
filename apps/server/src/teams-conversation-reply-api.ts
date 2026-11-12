import { createHash } from "node:crypto";
import { TeamsSendRejectedError } from "@assistant/features";
import type { TeamsConversationReplyResult } from "@assistant/contracts";
import type { AppContext } from "./application/context.js";
import { HttpError } from "./errors.js";
import { teamsConversationsApi } from "./teams-conversations-api.js";

export async function teamsConversationReplyApi(context: Pick<AppContext, "config" | "teamsStore" | "teamsSender">, method: string, url: URL, body: Record<string, unknown>) {
  if (method !== "POST" || url.pathname !== "/api/teams/conversations/reply") return;
  const { chatId, requestId } = body;
  if (typeof chatId !== "string" || !chatId || chatId.length > 1024 || /[\u0000-\u001f]/.test(chatId) || [".", ".."].includes(chatId)) throw new HttpError(400, "Teams 会话标识无效");
  if (typeof requestId !== "string" || !/^[0-9a-f-]{36}$/i.test(requestId)) throw new HttpError(400, "发送请求编号无效");
  if (typeof body.text !== "string" || !body.text.trim() || Buffer.byteLength(body.text, "utf8") > 16_000) throw new HttpError(400, "回复不能为空，且不能超过 16000 UTF-8 字节");
  const text = body.text;
  const fingerprint = createHash("sha256").update(JSON.stringify([chatId, text])).digest("hex");
  const { teamsStore: store, teamsSender: sender } = context, replies = store.directReplies;
  const replay = replies.find(requestId, chatId, fingerprint);
  if (replay) return { status: 200, data: replay };
  if (context.config.offline || !sender.send || !sender.read) throw new HttpError(503, "Teams 发送尚未连接，请检查账号配置");
  // Validate current access online; a remembered chat ID does not authorize a send.
  await teamsConversationsApi(context, "GET", new URL(`/api/teams/conversations/messages?chatId=${encodeURIComponent(chatId)}`, url));
  const accessGeneration = store.triage.accessGeneration(chatId);
  const canSend = () => !context.config.offline && store.sourceAllowed(`teams:${chatId}`) && store.triage.accessGeneration(chatId) === accessGeneration;
  if (!canSend()) throw new HttpError(403, "Teams 来源已不可用，尚未发送");
  if (!replies.claim(requestId, chatId, fingerprint)) return { status: 200, data: replies.find(requestId, chatId, fingerprint)! };
  let state: TeamsConversationReplyResult["state"] = "sent", error: string | undefined;
  try { await sender.send(chatId, text, canSend); }
  catch (failure) {
    state = failure instanceof TeamsSendRejectedError ? "rejected" : "unknown";
    error = state === "rejected" ? "Teams 未接受发送，请检查登录状态及 ChatMessage.Send 权限后重试。" : "发送结果未确认，请先在 Teams 核对，勿重复发送。";
  }
  // A failed local receipt write must never turn an accepted send into a retry.
  replies.finish(requestId, state, error);
  return { status: 200, data: { requestId, chatId, state, ...(error ? { error } : {}) } satisfies TeamsConversationReplyResult };
}
