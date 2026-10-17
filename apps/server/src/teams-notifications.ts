import type { NotificationSource, NotificationReview } from "@assistant/channel-wechat";
import type { TeamsStore } from "./teams-store.js";
import type { TeamsSender } from "./teams-reply-port.js";

// 投递前和每次重试都验证原始消息。校验失败则留在队列，不能把缓存当成最新状态发送。
export async function reviewTeamsNotification(store: TeamsStore, sender: TeamsSender, source: NotificationSource): Promise<NotificationReview> {
  if (!source.messageIds.length) throw new Error("Teams 提醒缺少来源");
  const unresolved = () => source.messageIds.map(id => store.message(id))
    .filter(row => row && row.direction === "in" && !row.repliedAt && Date.now() - Date.parse(row.createdAt) < 86400_000);
  // 已落库的回复与过期事实不依赖网络；服务未接好采集器也可以撤销。
  if (!unresolved().length) return { status: "cancel", reason: "来源消息已回复、超过 24 小时提醒窗口或已移出保留范围" };
  if (!(await sender.refresh?.())?.ok) throw new Error("Teams 同步不可用，暂缓自动提醒");
  const active = unresolved();
  if (!active.length) return { status: "cancel", reason: "刷新后来源消息均已回复或过期" };
  if (active.length === source.messageIds.length) return { status: "send" };
  // 混合摘要无法安全地靠字符串删句子：只重建仍有效来源的原文，不沿用失效的建议草稿。
  return { status: "send", text: "Teams · 当前仍未回复的来信（已移除失效提醒；以下为第三方原文）\n" + active.map(row =>
    `${row!.chatType === "oneOnOne" ? "私聊" : "群聊"}「${row!.chatTopic || row!.senderName}」 ${row!.createdAt}\n${row!.senderName}：${row!.text.slice(0, 500) || "[非文本消息]"}`).join("\n\n") };
}
