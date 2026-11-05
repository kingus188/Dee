import { TeamsSendRejectedError } from "@assistant/features";
import type { TeamsStore } from "./teams-store.js";
import { GRAPH, messageText, type GraphMessage } from "./teams-sync.js";

// 向指定聊天发一条纯文本消息。调用方必须已经完成用户确认；这里不做任何确认判断。
// 返回已入库的消息 ID（回执未保存时为 undefined），调用方可用它标记这条是代发消息。
export async function sendTeamsMessage(getToken: () => Promise<string>, chatId: string, text: string, store: TeamsStore, signal?: AbortSignal, canSend?: () => boolean): Promise<string | undefined> {
  let token: string;
  try { token = await getToken(); }
  catch { throw new TeamsSendRejectedError("发送前获取 Teams 凭据失败，请检查登录状态"); }
  if (signal?.aborted) throw new TeamsSendRejectedError("Teams 发送在请求开始前已取消");
  if (canSend && !canSend()) throw new TeamsSendRejectedError("自动代回授权或来源已失效，尚未开始发送");
  const response = await fetch(`${GRAPH}/chats/${encodeURIComponent(chatId)}/messages`, {
    method: "POST", redirect: "error", signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000),
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ body: { contentType: "text", content: text } }),
  });
  // 只报状态码，不回显响应体。
  if (!response.ok) {
    const reason = response.status === 403 ? "Graph 403，令牌缺少 ChatMessage.Send 授权" : `Graph ${response.status}`;
    // 4xx 明确拒绝请求（408 超时除外）；5xx / 网关超时可能发生在提交之后。
    if (response.status >= 400 && response.status < 500 && response.status !== 408) throw new TeamsSendRejectedError(reason);
    throw new Error(`${reason}，发送结果未知`);
  }
  // Graph 已接受后不能再抛错释放草稿，否则本地写入/解析失败会诱发重复发送。
  try {
    const message = await response.json() as GraphMessage;
    const id = `${chatId}:${message.id}`;
    if (!message.id || !message.from?.user?.id || !Number.isFinite(Date.parse(message.createdDateTime))) throw new Error("missing receipt");
    const chat = store.recentInChat(chatId, new Date().toISOString(), 1)[0];
    if (!chat) throw new Error("missing chat");
    store.record({ id, chatId, chatType: chat.chatType, chatTopic: chat.chatTopic ?? undefined,
      senderId: message.from.user.id, senderName: message.from.user.displayName ?? "我", direction: "out",
      text: messageText(message), createdAt: new Date(message.createdDateTime).toISOString(), important: false });
    return id;
  } catch { console.error("Teams 已接受发送，但本地回执未保存；下次同步补录，不重发。"); }
  return undefined;
}
