import { createHash } from "node:crypto";
import { defineDoc, type ConversationId, type EntryId, type Tx, type Cursor } from "@earendil-works/pi-durable";

export type NotificationSource = { kind: "teams"; messageIds: string[] };
export type NotificationReview = { status: "send"; text?: string } | { status: "cancel"; reason: string };
export const WechatNotifications = defineDoc<{
  items: { conversationId: ConversationId; requestId: string; source: NotificationSource }[];
}>({ kind: "app.wechat.notifications", version: 1, scope: "session", initial: () => ({ items: [] }) });

// 只使用持久 submission 的 answer 关联，不从助手文案、姓名或引用摘要猜来源。
// 一个回答若同时响应普通用户输入，不能整条按自动提醒撤销。
export async function notificationForAnswer(tx: Tx, conversationId: ConversationId, answer: number): Promise<NotificationSource | undefined> {
  const sources: NotificationSource[] = [];
  const inputIds = new Set<number>();
  for (const item of (await tx.doc(WechatNotifications)).items) {
    if (item.conversationId !== conversationId) continue;
    const submission = await tx.submissionByRequest(conversationId, item.requestId);
    if (submission?.type === "input" && submission.status === "done" && submission.answer === answer) {
      inputIds.add(submission.entry);
      sources.push(item.source);
    }
  }
  if (!sources.length) return;
  let cursor: Cursor | undefined;
  do {
    const page = await tx.scanEntries({ conversationId, maxEntryId: (answer - 1) as EntryId, order: "descending" }, 100, cursor);
    let boundary = false;
    for (const entry of page.items) {
      if (entry.kind === "pi.user" && !inputIds.has(entry.id)) return;
      const content = entry.model?.[0]?.content;
      if (entry.kind === "pi.assistant" && content && !(Array.isArray(content) && content.some(part => part.type === "toolCall"))) { boundary = true; break; }
    }
    if (boundary) break;
    cursor = page.next;
  } while (cursor !== undefined);
  return { kind: "teams", messageIds: [...new Set(sources.flatMap(source => source.messageIds))] };
}

export async function recoverLegacyTeams(tx: Tx,
  bindings: readonly { key: string; binding: string; wxid: string; conversationId: ConversationId }[],
  outbox: { id: string; binding: string; wxid: string; status: string; source?: NotificationSource }[],
  messageIds: readonly string[], requestIdFor: (binding: string, wxid: string, id: string) => string,
) {
  const tracked = await tx.doc(WechatNotifications);
  let linked = 0;
  for (const binding of bindings) {
    const candidates = outbox.filter(item => item.binding === binding.binding && item.wxid === binding.wxid && !item.source && ["pending", "sending", "blocked"].includes(item.status));
    if (!candidates.length) continue;
    const temporary: typeof tracked.items = [];
    for (const messageId of messageIds) {
      const digits = BigInt("0x" + createHash("sha256").update(messageId).digest("hex").slice(0, 24)).toString();
      const requestId = requestIdFor(binding.binding, binding.wxid, digits);
      const submission = await tx.submissionByRequest(binding.conversationId, requestId);
      if (submission?.type !== "input" || submission.status !== "done" || !candidates.some(item => item.id === binding.key + ":" + submission.answer)) continue;
      const content = (await tx.entry(submission.entry))?.model?.[0]?.content;
      const text = typeof content === "string" ? content : content?.filter(part => part.type === "text").map(part => part.text).join("") ?? "";
      if (!text.startsWith("[Teams ")) continue;
      temporary.push({ conversationId: binding.conversationId, requestId, source: { kind: "teams", messageIds: [messageId] } });
    }
    const count = tracked.items.length;
    tracked.items.push(...temporary);
    for (const item of candidates) {
      const source = await notificationForAnswer(tx, binding.conversationId, Number(item.id.slice(binding.key.length + 1)));
      if (source) { item.source = source; linked++; }
    }
    tracked.items.splice(count);
  }
  return { linked, unknown: outbox.filter(item => !item.source && ["pending", "sending", "blocked"].includes(item.status)).length };
}
