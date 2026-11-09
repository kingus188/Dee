import { createHash } from "node:crypto";
import type { ConversationId, EntryRecord } from "@earendil-works/pi-durable";
import type { TeamsChatRecord } from "@assistant/contracts";
import { WechatNotifications, WechatState, validateInbound } from "@assistant/channel-wechat";
import type { AppContext } from "./application/context.js";
import type { TeamsStore } from "./teams-store.js";
import { teamsRecords } from "./teams-records.js";

function sourceRecords(store: TeamsStore, messageIds: string[]): TeamsChatRecord[] {
  const latest = messageIds.flatMap(id => store.message(id) ?? [])
    .filter(row => store.archive.messageReadable(row.chatId, row.id.slice(row.chatId.length + 1)));
  const labels = new Map(latest.map(row => [row.chatId, row.chatType === "oneOnOne" ? row.senderName : row.chatTopic || store.archive.chatLabel(row.chatId)]));
  const rows = new Map(latest.map(row => [row.id, row]));
  if (messageIds.length === 1 && latest.length === 1) {
    for (const row of store.recentInChat(latest[0].chatId, latest[0].createdAt, 6)) {
      if (!row.notificationCancelledAt) rows.set(row.id, row);
    }
  }
  return [...rows.values()].flatMap(row => {
    if (!Number.isFinite(Date.parse(row.createdAt))) return [];
    const id = row.id.slice(row.chatId.length + 1);
    if (!store.archive.messageReadable(row.chatId, id)) return [];
    const original = store.archive.message(row.chatId, id);
    const record = original ? teamsRecords(store.archive, [{ ...original, chatId: row.chatId }])[0] : undefined;
    return [{ ...(record ?? { chatId: row.chatId, id, chatLabel: row.chatTopic || row.senderName,
      sender: row.senderName, createdAt: row.createdAt, text: row.text, deleted: false, media: row.media ?? [] }), chatLabel: labels.get(row.chatId)!, direction: row.direction }];
  }).sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt) || a.id.localeCompare(b.id));
}

// Link the persisted host submission, never classify ordinary user text by its wording.
export function createTeamsForwardView({ harness, ctx, teamsStore }: Pick<AppContext, "harness" | "ctx" | "teamsStore">) {
 const linked = new Map<ConversationId, Map<number, { ids: string[]; requestId: string }>>();
 return async (conversationId: ConversationId, entries: readonly EntryRecord[]) => {
  const inputs = new Map(entries.filter(entry => entry.kind === "pi.user").map(entry => [Number(entry.id), entry]));
  const result = new Map<number, { records: TeamsChatRecord[] }>();
  const known = linked.get(conversationId) ?? new Map<number, { ids: string[]; requestId: string }>();
  linked.set(conversationId, known);
  // Entry/source identity is immutable; source content and revocation are re-read every frame.
  for (const [id, { ids }] of known) if (inputs.has(id)) {
    result.set(id, { records: sourceRecords(teamsStore, ids) });
    inputs.delete(id);
  }
  if (!inputs.size) return result;
  const tracked = await harness.snapshot(WechatNotifications, ctx);
  const sources = new Map((tracked?.items ?? []).filter(item => item.conversationId === conversationId).map(item => [item.requestId, item.source.messageIds]));
  const state = await harness.snapshot(WechatState, ctx);
  const bindings = Object.values(state?.bindings ?? {}).filter(binding => binding.conversationId === conversationId);
  if (!sources.size && !bindings.length) return result;
  // Delivery prunes the temporary tracker; frozen batches retain the exact source set.
  for (const binding of bindings) for (const ids of teamsStore.notificationHistorySources()) {
    const digest = createHash("sha256").update(JSON.stringify([...ids].sort())).digest("hex");
    const digits = BigInt("0x" + digest.slice(0, 24)).toString();
    const requestId = "notification:" + validateInbound({ binding: binding.binding, from_wxid: binding.wxid, message_id: digits, text: "history" }).requestId;
    if (!sources.has(requestId)) sources.set(requestId, ids);
  }
  const knownRequests = new Set([...known.values()].map(item => item.requestId));
  // This transaction only reads submissions; an empty write set creates no commit.
  await harness.commit(async tx => {
    const link = async (requestId: string, ids: string[]) => {
      if (knownRequests.has(requestId)) return;
      const submission = await tx.submissionByRequest(conversationId, requestId);
      if (submission?.type !== "input" || submission.entry === undefined || !inputs.has(submission.entry)) return;
      known.set(submission.entry, { ids, requestId });
      result.set(submission.entry, { records: sourceRecords(teamsStore, ids) });
      inputs.delete(submission.entry);
    };
    for (const [requestId, ids] of sources) await link(requestId, ids);
    // The prefix only bounds old lookups; the persisted request digest proves origin.
    const legacyInputs = [...inputs.values()].some(entry => {
      const content = entry.model?.[0]?.content;
      return (typeof content === "string" ? content : content?.filter(part => part.type === "text").map(part => part.text).join("") ?? "").startsWith("[Teams ");
    });
    if (legacyInputs) for (const binding of bindings) for (const id of teamsStore.notificationHistoryIds()) {
      const digits = BigInt("0x" + createHash("sha256").update(id).digest("hex").slice(0, 24)).toString();
      await link(validateInbound({ binding: binding.binding, from_wxid: binding.wxid, message_id: digits, text: "legacy" }).requestId, [id]);
    }
  }, ctx);
  return result;
 };
}
