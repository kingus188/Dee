import type { TeamsDeliveryIssues, TeamsDeliveryRecheck } from "@assistant/contracts";
import type { AppContext } from "./application/context.js";
import { messageText } from "./teams-message-text.js";
import type { GraphMessage } from "./teams-sync.js";
import { HttpError } from "./errors.js";

type Context = Pick<AppContext, "config" | "teamsStore" | "teamsSender">;
/** Rechecks source evidence only. A raw transport has no receipt lookup or safe resend contract. */
export async function teamsDeliveryApi(context: Context, method: string, url: URL, body: Record<string, unknown>) {
  if (url.pathname !== "/api/teams/delivery-issues" && url.pathname !== "/api/teams/delivery-issues/recheck") return;
  const { teamsStore: store, teamsSender: sender } = context;
  const available = !context.config.offline && !!sender.read;
  if (method === "GET" && url.pathname === "/api/teams/delivery-issues") {
    return { status: 200, data: { available, ...store.notifications.deliveryIssues() } satisfies TeamsDeliveryIssues };
  }
  if (method !== "POST" || url.pathname !== "/api/teams/delivery-issues/recheck") return;
  if (typeof body.id !== "string" || !/^teams-digest:[a-f0-9]{64}$/.test(body.id)) throw new HttpError(400, "Teams 提醒编号无效");
  if (!available) throw new HttpError(503, "Teams 来源读取未连接，未重新发送任何消息");
  const batch = store.notifications.deliveryIssueSource(body.id);
  if (!batch) throw new HttpError(409, "该提醒已不在结果未知列表，请刷新后核对");
  const invalid = () => !batch.sourceRevisions.length || !batch.sourceRevisions.every(ref => store.sourceAllowed(ref.source, ref.revision));
  let sourceCheck: TeamsDeliveryRecheck["sourceCheck"] = invalid() ? "invalidated" : "verified";
  if (sourceCheck === "verified") {
    for (const id of batch.messageIds) {
      const message = store.message(id);
      if (!message) { sourceCheck = "invalidated"; break; }
      const messageId = id.slice(message.chatId.length + 1);
      try {
        const result = await sender.read!({ kind: "history", chatId: message.chatId, messageId });
        const data = result.data;
        if (!data || typeof data !== "object" || !("id" in data) || data.id !== messageId) throw new Error("unverified source");
        if (("deletedDateTime" in data && data.deletedDateTime) || ("chatId" in data && data.chatId !== message.chatId) || messageText(data as GraphMessage) !== message.text) { sourceCheck = "invalidated"; break; }
      } catch { throw new HttpError(503, "来源重新核对未完成，送达仍未确认；没有重发"); }
      if (invalid()) { sourceCheck = "invalidated"; break; }
    }
  }
  const item = store.notifications.deliveryIssues().items.find(item => item.id === batch.id);
  if (!item) throw new HttpError(409, "提醒状态已变化，请刷新后核对");
  if (invalid()) sourceCheck = "invalidated";
  return { status: 200, data: { item: sourceCheck === "invalidated" ? { ...item, sourceStatus: "invalidated" as const } : item, sourceCheck, deliveryCheck: "unconfirmed" } satisfies TeamsDeliveryRecheck };
}
