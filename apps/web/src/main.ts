import { initializeTaskCenter } from "./tasks/center.js";
import { formatDuration } from "./ui/format.js";
import { showToast } from "./ui/toast.js";
import { createState } from "./state.js";
import type { AppActions } from "./state.js";
import { createUiRender } from "./ui/render.js";
import { createChatAttachments } from "./chat/attachments.js";
import { createConversationsList } from "./conversations/list.js";
import { createConversationsController } from "./conversations/controller.js";
import { createApiEvents } from "./api/events.js";
import { createUiStatus } from "./ui/status.js";
import { createUiMascot } from "./ui/mascot.js";
import { createChatMessages } from "./chat/messages.js";
import { createTasksPanels } from "./tasks/panels.js";
import { createChatComposer } from "./chat/composer.js";
import { createUiShell } from "./ui/shell.js";

const state = createState();
const actions: AppActions = {
...createUiRender(),
...createChatAttachments(state),
...createConversationsList(state, () => actions),
...createConversationsController(state, () => actions),
...createApiEvents(state, () => actions),
...createUiStatus(state, () => actions),
...createUiMascot(state),
...createChatMessages(state, () => actions),
...createTasksPanels(state, () => actions),
...createChatComposer(state, () => actions),
...createUiShell(() => actions)
};
// --- 倒计时时钟（每秒更新一次定时提醒面板和小 D 倒计时文案） ---
function startTimerTick() {
    if (state.timerTickInterval)
        clearInterval(state.timerTickInterval);
    state.timerTickInterval = setInterval(() => {
        const now = Date.now();
        // 1. 更新定时提醒面板内的倒计时徽章
        const badges = document.querySelectorAll('.reminder-badge.scheduled');
        badges.forEach(badge => {
            const at = Number(badge.getAttribute('data-at'));
            if (at) {
                const diff = at - now;
                badge.textContent = diff > 0 ? `倒计时 ${formatDuration(diff)}` : '即将触发';
            }
        });
        // 2. 如果吉祥物处于提醒状态，刷新气泡中的倒计时
        const mascotCard = document.getElementById('mascot-card')!;
        if (mascotCard && mascotCard.getAttribute('data-state') === 'reminder') {
            actions.updateMascotState();
        }
    }, 1000);
}

// --- 定时拉取会话列表（每 10 秒刷新一次会话列表标题） ---
function startConversationsInterval() {
    if (state.conversationsInterval)
        clearInterval(state.conversationsInterval);
    state.conversationsInterval = setInterval(() => {
        actions.fetchConversations();
    }, 10000);
}

// --- 事件监听与初始化 ---
window.addEventListener('DOMContentLoaded', () => {
    initializeTaskCenter();
    actions.setupMascotSvgs();
    actions.fetchServerInfo();
    actions.fetchConversations(true);
    startTimerTick();
    startConversationsInterval();
    actions.setupDragAndDrop();
    const chatContainer = document.getElementById('messages-container')!;
    if (chatContainer) {
        chatContainer.addEventListener('scroll', () => {
            state.autoScrollChat = chatContainer.scrollHeight - chatContainer.scrollTop - chatContainer.clientHeight < 80;
        });
    }
    const fileInput = (document.getElementById('file-input') as HTMLInputElement);
    if (fileInput) {
        fileInput.addEventListener('change', async () => {
            if (fileInput.files && fileInput.files.length > 0) {
                await actions.handleFilesSelected(fileInput.files);
            }
        });
    }
    const textarea = (document.getElementById('chat-textarea') as HTMLTextAreaElement);
    if (textarea) {
        textarea.addEventListener('input', () => {
            textarea.style.height = 'auto';
            textarea.style.height = Math.min(textarea.scrollHeight, 140) + 'px';
            actions.updateSendButtonState();
        });
        textarea.addEventListener('paste', async (e) => {
            const clipboardData = e.clipboardData;
            if (!clipboardData || !clipboardData.files || clipboardData.files.length === 0)
                return;
            const files = Array.from(clipboardData.files);
            if (files.length > 0) {
                e.preventDefault();
                await actions.handleFilesSelected(files);
            }
        });
        textarea.addEventListener('compositionstart', () => { state.isComposing = true; });
        textarea.addEventListener('compositionend', () => {
            state.isComposing = false;
            actions.updateSendButtonState();
        });
        textarea.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey && !state.isComposing) {
                e.preventDefault();
                actions.submitMessage();
            }
        });
    }
    // 手机上输入框较窄，长提示会折成两行被截断
    if (textarea && window.matchMedia('(max-width: 860px)').matches) {
        textarea.placeholder = '输入消息…';
    }
    actions.updateSendButtonState();
    window.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && actions.crashModal.style.display === 'flex') {
            actions.closeCrashModal();
        }
    });
    window.addEventListener('hashchange', () => {
        const hashId = actions.parseHashConversationId();
        if (hashId !== null && String(hashId) !== String(state.currentConversationId)) {
            const hashed = state.conversations.find((c) => String(c.id) === String(hashId));
            if (hashed?.archivedAt)
                state.conversationView = 'archived';
            actions.selectConversation(hashId);
        }
    });
    const conversationList = document.getElementById('conversation-list')!;
    if (conversationList)
        conversationList.addEventListener('click', actions.onConversationListClick);
});

// 显式挂载到 window，确保 inline onclick 与外部完全兼容
window.selectConversation = actions.selectConversation;

window.submitMessage = actions.submitMessage;

window.abortCurrentTask = actions.abortCurrentTask;

window.forkConversation = actions.forkConversation;

window.openCrashModal = actions.openCrashModal;

window.closeCrashModal = actions.closeCrashModal;

window.confirmCrash = actions.confirmCrash;

window.onModalBackdropClick = actions.onModalBackdropClick;

window.openSidebarDrawer = actions.openSidebarDrawer;

window.closeSidebarDrawer = actions.closeSidebarDrawer;

window.createNewConversation = actions.createNewConversation;

window.setConversationView = actions.setConversationView;

window.goBackToParentConversation = actions.goBackToParentConversation;

window.toggleMobileMascotBubble = actions.toggleMobileMascotBubble;

window.toggleToolResultExpand = actions.toggleToolResultExpand;

window.insertExamplePrompt = actions.insertExamplePrompt;

window.triggerFileInput = actions.triggerFileInput;

window.removePendingAttachment = actions.removePendingAttachment;

window.showToast = showToast;
declare global { interface Window {
selectConversation: AppActions["selectConversation"];
submitMessage: AppActions["submitMessage"];
abortCurrentTask: AppActions["abortCurrentTask"];
forkConversation: AppActions["forkConversation"];
openCrashModal: AppActions["openCrashModal"];
closeCrashModal: AppActions["closeCrashModal"];
confirmCrash: AppActions["confirmCrash"];
onModalBackdropClick: AppActions["onModalBackdropClick"];
openSidebarDrawer: AppActions["openSidebarDrawer"];
closeSidebarDrawer: AppActions["closeSidebarDrawer"];
createNewConversation: AppActions["createNewConversation"];
setConversationView: AppActions["setConversationView"];
goBackToParentConversation: AppActions["goBackToParentConversation"];
toggleMobileMascotBubble: AppActions["toggleMobileMascotBubble"];
toggleToolResultExpand: AppActions["toggleToolResultExpand"];
insertExamplePrompt: AppActions["insertExamplePrompt"];
triggerFileInput: AppActions["triggerFileInput"];
removePendingAttachment: AppActions["removePendingAttachment"];
showToast: typeof showToast;
__liveLogged?: boolean;
} }
