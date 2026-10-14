import { GRAPH } from "./teams-forward.js";

// 向指定聊天发一条纯文本消息。调用方必须已经完成用户确认；这里不做任何确认判断。
export async function sendTeamsMessage(getToken: () => Promise<string>, chatId: string, text: string) {
  const response = await fetch(`${GRAPH}/chats/${encodeURIComponent(chatId)}/messages`, {
    method: "POST", signal: AbortSignal.timeout(30_000),
    headers: { Authorization: `Bearer ${await getToken()}`, "Content-Type": "application/json" },
    body: JSON.stringify({ body: { contentType: "text", content: text } }),
  });
  // 只报状态码，不回显响应体。
  if (!response.ok) throw new Error(response.status === 403 ? "Graph 403，令牌缺少 ChatMessage.Send 授权" : `Graph ${response.status}`);
}
