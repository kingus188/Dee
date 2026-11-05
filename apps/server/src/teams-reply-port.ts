import type { TeamsReadPort, TeamsReplyPort, TeamsSyncStatus } from "@assistant/features";
import type { TeamsStore } from "./teams-store.js";

// 发送函数由桌面端在拿到 Teams 令牌后挂上；未挂时 send_teams_reply 会说明未启用。
export type TeamsSender = { send?: (chatId: string, text: string) => Promise<void>; refresh?: () => Promise<TeamsSyncStatus & { refreshedChatIds?: string[] }>; syncStatus?: () => { lastSuccessAt: string | null }; read?: TeamsReadPort };

export function createTeamsReplyPort(store: TeamsStore, sender: TeamsSender, offline = false): TeamsReplyPort {
  return {
    findChats: name => store.findChats(name),
    saveDraft: draft => store.saveDraft(draft),
    alreadyReplied: chatId => store.alreadyReplied(chatId),
    pendingDrafts: (conversationId, maxAgeMs) => store.pendingDrafts(conversationId, maxAgeMs),
    claim: (id, conversationId, maxAgeMs) => store.claim(id, conversationId, maxAgeMs),
    release: id => store.release(id),
    markDelivery: (id, state) => store.markDelivery(id, state),
    delivery: (id, conversationId) => store.delivery(id, conversationId),
    unresolvedDrafts: conversationId => store.unresolvedDrafts(conversationId),
    blockedDraft: chatId => store.blockedDraft(chatId),
    resolveDelivery: (id, conversationId, state, sourceEntryId) => store.resolveDelivery(id, conversationId, state, sourceEntryId),
    unresolvedAutoReplies: () => store.unresolvedAutoReplies(),
    blockedAutoReply: chatId => store.blockedAutoReply(chatId),
    resolveAutoReply: (id, state) => store.resolveAutoReply(id, state),
    get send() { return offline ? undefined : sender.send; },
  };
}
