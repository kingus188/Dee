import type { TeamsStore } from "./teams-store.js";
import { GRAPH, messageText, type GraphMessage } from "./teams-sync.js";

// 向指定聊天发一条纯文本消息。调用方必须已经完成用户确认；这里不做任何确认判断。
// 返回已入库的消息 ID（回执未保存时为 undefined），调用方可用它标记这条是代发消息。
export async function sendTeamsMessage(getToken: () => Promise<string>, chatId: string, text: string, store: TeamsStore, signal?: AbortSignal): Promise<string | undefined> {
  const token = await getToken();
  signal?.throwIfAborted();
  const response = await fetch(`${GRAPH}/chats/${encodeURIComponent(chatId)}/messages`, {
    method: "POST", signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000),
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ body: { contentType: "text", content: text } }),
  });
  // 只报状态码，不回显响应体。
  if (!response.ok) throw new Error(response.status === 403 ? "Graph 403，令牌缺少 ChatMessage.Send 授权" : `Graph ${response.status}`);
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
