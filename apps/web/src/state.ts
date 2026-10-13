import type { BrowserView, PendingAttachment, ServerInfo } from "./types.js";
export interface AppState {
currentConversationId: string | number | null;
currentEventSource: EventSource | null;
currentViewData: BrowserView | null;
serverInfo: ServerInfo | null;
previousBoots: number | null;
isComposing: boolean;
autoScrollChat: boolean;
pendingAttachments: PendingAttachment[];
isSending: boolean;
isDisconnected: boolean;
isRecovered: boolean;
recoveredUntil: number;
timerTickInterval: ReturnType<typeof setInterval> | null;
}
export function createState(): AppState { return {
currentConversationId: null,
currentEventSource: null,
currentViewData: null,
serverInfo: null,
previousBoots: null,
isComposing: false,
autoScrollChat: true,
pendingAttachments: [],
isSending: false,
isDisconnected: false,
isRecovered: false,
recoveredUntil: 0,
timerTickInterval: null
}; }
export interface AppActions {
patchChildren: (target: HTMLElement, staging: HTMLElement) => void;
updateSendButtonState: () => void;
setupDragAndDrop: () => void;
handleFilesSelected: (fileList: FileList | File[]) => Promise<void>;
triggerFileInput: () => void;
removePendingAttachment: (index: number) => void;
connectDirectChat: () => Promise<void>;
connectSse: (conversationId: string | number) => void;
hideReconnectBanner: () => void;
fetchServerInfo: () => Promise<void>;
showReconnectBanner: () => void;
updateMascotState: () => void;
setupMascotSvgs: () => void;
renderEmptyConversation: (container: HTMLElement) => void;
renderView: (view: BrowserView) => void;
initializeConversationCards: () => void;
resetConversationCards: () => void;
updateConversationCards: () => void;
updateBusyControls: (isBusy: boolean, inboxCount: number) => void;
submitMessage: () => Promise<void>;
abortCurrentTask: () => Promise<void>;
insertExamplePrompt: (text: string) => void;
}
