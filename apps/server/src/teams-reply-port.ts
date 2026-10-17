import type { TeamsReplyPort, TeamsSyncStatus } from "@assistant/features";
import type { TeamsStore } from "./teams-store.js";

// 发送函数由桌面端在拿到 Teams 令牌后挂上；未挂时 send_teams_reply 会说明未启用。
export type TeamsSender = { send?: (chatId: string, text: string) => Promise<void>; refresh?: () => Promise<TeamsSyncStatus>; syncStatus?: () => { lastSuccessAt: string | null } };

export function createTeamsReplyPort(store: TeamsStore, sender: TeamsSender, offline = false): TeamsReplyPort {
  return {
    findChats: name => store.findChats(name),
    saveDraft: draft => store.saveDraft(draft),
    alreadyReplied: chatId => store.alreadyReplied(chatId),
    pendingDrafts: (conversationId, maxAgeMs) => store.pendingDrafts(conversationId, maxAgeMs),
    claim: (id, conversationId, maxAgeMs) => store.claim(id, conversationId, maxAgeMs),
    release: id => store.release(id),
    get send() { return offline ? undefined : sender.send; },
  };
}
