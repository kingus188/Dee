import type { BrowserView, ConversationItem, PendingAttachment, ServerInfo } from "./types.js";
export interface AppState {
currentConversationId: string | number | null;
conversations: ConversationItem[];
conversationView: string;
pendingRemoveId: string | null;
shelfBusy: boolean;
currentEventSource: EventSource | null;
currentViewData: BrowserView | null;
serverInfo: ServerInfo | null;
previousBoots: number | null;
isComposing: boolean;
autoScrollChat: boolean;
seenUserMessageConvs: Set<unknown>;
conversationsInterval: ReturnType<typeof setInterval> | null;
pendingAttachments: PendingAttachment[];
isSending: boolean;
isDisconnected: boolean;
isRecovered: boolean;
recoveredUntil: number;
timerTickInterval: ReturnType<typeof setInterval> | null;
}
export function createState(): AppState { return {
currentConversationId: null,
conversations: [],
conversationView: 'active',
pendingRemoveId: null,
shelfBusy: false,
currentEventSource: null,
currentViewData: null,
serverInfo: null,
previousBoots: null,
isComposing: false,
autoScrollChat: true,
seenUserMessageConvs: new Set(),
conversationsInterval: null,
pendingAttachments: [],
isSending: false,
isDisconnected: false,
isRecovered: false,
recoveredUntil: 0,
timerTickInterval: null
}; }
export interface AppActions {
stagingFor: (id: string) => HTMLElement | null;
patchChildren: (target: HTMLElement, staging: HTMLElement) => void;
updateSendButtonState: () => void;
clearPendingAttachments: () => void;
setupDragAndDrop: () => void;
handleFilesSelected: (fileList: FileList | File[]) => Promise<void>;
triggerFileInput: () => void;
removePendingAttachment: (index: number) => void;
renderConversationList: () => void;
updateConversationHeaders: () => void;
fetchConversations: (isInitial?: boolean) => Promise<boolean>;
createNewConversation: () => Promise<void>;
parseHashConversationId: () => string | null;
selectConversation: (id: string | number) => void;
onConversationListClick: (e: MouseEvent) => void;
forkConversation: (entryId: string | number) => Promise<void>;
setConversationView: (view: string) => void;
goBackToParentConversation: (e: Event) => void;
connectSse: (conversationId: string | number) => void;
hideReconnectBanner: () => void;
fetchServerInfo: () => Promise<void>;
showReconnectBanner: () => void;
updateMascotState: () => void;
setupMascotSvgs: () => void;
toggleMobileMascotBubble: (e?: Event) => void;
renderEmptyConversation: (container: HTMLElement) => void;
renderView: (view: BrowserView) => void;
toggleToolResultExpand: (btn: HTMLButtonElement) => void;
renderNotes: (notes: BrowserView["notes"]) => void;
renderReminders: (reminders: BrowserView["reminders"]) => void;
renderTasks: (tasks: BrowserView["tasks"]) => void;
updateBusyControls: (isBusy: boolean, inboxCount: number) => void;
submitMessage: () => Promise<void>;
abortCurrentTask: () => Promise<void>;
insertExamplePrompt: (text: string) => void;
closeSidebarDrawer: () => void;
crashModal: HTMLElement;
closeCrashModal: () => void;
openCrashModal: () => void;
confirmCrash: () => Promise<void>;
onModalBackdropClick: (e: Event) => void;
openSidebarDrawer: () => void;
}
