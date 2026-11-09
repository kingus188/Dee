import type { Context } from "@earendil-works/chord";
import type { Message } from "@earendil-works/pi-ai";
import type { Cursor } from "@earendil-works/pi-durable";
import { Index, type ConversationItem, type Runtime } from "@assistant/runtime";
import { WechatState } from "@assistant/channel-wechat";
import { splitUserContent } from "@assistant/features";

export function needsConversationTitle(item: ConversationItem) {
  return !item.archivedAt && !item.forkOf && (!item.channel || item.channel === "web") &&
    (!item.title?.trim() || item.title === "小 D" || item.title === "新对话");
}

export function initialConversationTitle(content: Message["content"] | undefined) {
  const { text, attachments } = splitUserContent(content);
  const value = text.trim() || (attachments[0] ? `[附件] ${attachments[0].name}` : "");
  return Array.from(value).slice(0, 20).join("");
}

// Repair only placeholder metadata before work resumes; never regenerate named sessions.
export async function repairConversationTitles({ harness, root }: Pick<Runtime, "harness" | "root">, ctx: Context) {
  const index = await harness.snapshot(Index, ctx);
  const candidates = (index?.items ?? []).filter(needsConversationTitle);
  if (!candidates.length) return 0;
  const wechat = await harness.snapshot(WechatState, ctx);
  const bound = new Set(Object.values(wechat?.bindings ?? {}).map(binding => Number(binding.conversationId)));
  const titles = new Map<number, { before: string; title: string }>();
  for (const item of candidates) {
    if (bound.has(Number(item.id))) continue;
    const conversation = await harness.conversation(item.id, ctx);
    if (!conversation) continue;
    let cursor: Cursor | undefined;
    do {
      const page = await conversation.entries({ order: "ascending" }, 50, cursor, ctx);
      for (const entry of page.items) {
        const message = entry.model?.[0];
        if (entry.kind !== "pi.user" || message?.role !== "user") continue;
        const title = initialConversationTitle(message.content);
        if (title) { titles.set(item.id, { before: item.title, title }); break; }
      }
      cursor = page.next;
    } while (!titles.has(item.id) && cursor !== undefined);
  }
  if (!titles.size) return 0;
  return root.commit(async tx => {
    let changed = 0;
    for (const item of (await tx.doc(Index)).items) {
      const proposal = titles.get(item.id);
      if (!proposal || item.title !== proposal.before || !needsConversationTitle(item)) continue;
      item.title = proposal.title;
      changed++;
    }
    return changed;
  }, ctx);
}
