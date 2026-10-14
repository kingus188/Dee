import type { TeamsReplyPort } from "@assistant/features";
import type { TeamsStore } from "./teams-store.js";

// 发送函数由桌面端在拿到 Teams 令牌后挂上；未挂时 send_teams_reply 会说明未启用。
export type TeamsSender = { send?: (chatId: string, text: string) => Promise<void> };

export function createTeamsReplyPort(store: TeamsStore, sender: TeamsSender): TeamsReplyPort {
  return {
    findChats: name => store.findChats(name),
    saveDraft: draft => store.saveDraft(draft),
    latestDraft: (conversationId, maxAgeMs) => store.latestDraft(conversationId, maxAgeMs),
    claim: id => store.claim(id),
    release: id => store.release(id),
    get send() { return sender.send; },
  };
}
