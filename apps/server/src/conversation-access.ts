import type { Tx } from "@earendil-works/pi-durable";
import type { Context } from "@earendil-works/chord";
import { Index, type Runtime } from "@assistant/runtime";
import { WechatState } from "@assistant/channel-wechat";
import type { EpisodeStore } from "./episode-store.js";

export class PrivateConversationAccessError extends Error {}

// Shared audience boundary for private history and its derived summaries.
export function createPrivateConversationAccess(runtime: Runtime, ctx: Context, sources: Pick<EpisodeStore, "sourceAllowed">) {
  return async (requesterId: number | undefined, tx?: Tx) => {
    const index = tx ? await tx.doc(Index) : await runtime.harness.snapshot(Index, ctx);
    const bindings = (tx ? await tx.doc(WechatState) : await runtime.harness.snapshot(WechatState, ctx))?.bindings ?? {};
    const bound = new Set(Object.values(bindings).map(binding => Number(binding.conversationId)));
    const privateItems = (index?.items ?? []).filter(item => item.id !== runtime.root.id
      && (!item.channel || item.channel === "web" || item.channel === "desktop")
      && !bound.has(item.id) && sources.sourceAllowed(`conv:${item.id}`));
    // Unindexed child/internal sessions and external channel callers cannot use this capability.
    if (requesterId !== undefined && ((!Number.isSafeInteger(requesterId) || requesterId <= 0) || !privateItems.some(item => item.id === requesterId && !item.archivedAt && !item.archivingAt))) throw new PrivateConversationAccessError("当前对话不能查询私人对话记录");
    return privateItems;
  };
}
