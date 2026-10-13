import { openDirectConversation } from "../api/conversations.js";
import type { AppState, AppActions } from "../state.js";

type DirectChatActions = Pick<AppActions, "connectSse" | "resetConversationCards">;
export function createDirectChat(state: AppState, getActions: () => DirectChatActions) {
  let connecting: Promise<void> | null = null;
  function connectDirectChat(): Promise<void> {
    if (state.currentConversationId !== null) return Promise.resolve();
    if (connecting) return connecting;
    connecting = openDirectConversation().then(({ id }) => {
      state.currentConversationId = id;
      state.currentViewData = null;
      getActions().resetConversationCards();
      getActions().connectSse(id);
    }).finally(() => { connecting = null; });
    return connecting;
  }
  return { connectDirectChat };
}
