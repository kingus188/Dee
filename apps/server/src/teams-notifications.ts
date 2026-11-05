import type { NotificationSource, NotificationReview } from "@assistant/channel-wechat";
import type { TeamsStore } from "./teams-store.js";
import type { TeamsSender } from "./teams-reply-port.js";
import { teamsNoticePriority } from "./teams-notification-batches.js";
import { notificationDeliveryAt } from "./notification-policy.js";

// 投递前和每次重试都验证原始消息。校验失败则留在队列，不能把缓存当成最新状态发送。
export async function reviewTeamsNotification(store: TeamsStore, sender: TeamsSender, source: NotificationSource): Promise<NotificationReview> {
  if (!source.messageIds.length) throw new Error("Teams 提醒缺少来源");
  const unresolved = () => source.messageIds.map(id => store.message(id))
    .filter(row => row && row.direction === "in" && !row.repliedAt && !row.notificationCancelledAt && Date.now() - Date.parse(row.createdAt) < 86400_000);
  // 已落库的回复与过期事实不依赖网络；服务未接好采集器也可以撤销。
  if (!unresolved().length) return { status: "cancel", reason: "来源消息已回复、删除、超过 24 小时提醒窗口或已移出保留范围" };
  const refreshed = await sender.refresh?.();
  if (!refreshed?.ok) throw new Error("Teams 同步不可用，暂缓自动提醒");
  const active = unresolved();
  if (!active.length) return { status: "cancel", reason: "刷新后来源消息均已回复或过期" };
  // A successful overall sync can skip forbidden or removed chats. Only the
  // collector's per-chat proof confirms this source was actually rechecked.
  if (refreshed.refreshedChatIds && active.some(item => !refreshed.refreshedChatIds!.includes(item!.chatId))) {
    throw new Error("Teams 来源聊天本轮未能核对，暂缓自动提醒");
  }
  const at = Date.now();
  const due = notificationDeliveryAt(store.notifications.quietHours(), at, teamsNoticePriority(active.filter(item => item !== undefined)));
  if (due > at) return { status: "defer", until: due };
  if (active.length === source.messageIds.length) return { status: "send" };
  // 混合摘要无法安全地靠字符串删句子：只重建仍有效来源的原文，不沿用失效的建议草稿。
  return { status: "send", text: "Teams · 当前仍未回复的来信（已移除失效提醒；以下为第三方原文）\n" + active.map(row =>
    `${row!.chatType === "oneOnOne" ? "私聊" : "群聊"}「${row!.chatTopic || row!.senderName}」 ${row!.createdAt}\n${row!.senderName}：${row!.text.slice(0, 500) || "[非文本消息]"}`).join("\n\n") };
}
