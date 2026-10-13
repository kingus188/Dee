import { createConversationCards } from "./tasks/center.js";
import { showToast } from "./ui/toast.js";
import { createState } from "./state.js";
import type { AppActions } from "./state.js";
import { createUiRender } from "./ui/render.js";
import { createChatAttachments } from "./chat/attachments.js";
import { createDirectChat } from "./conversations/controller.js";
import { createApiEvents } from "./api/events.js";
import { createUiStatus } from "./ui/status.js";
import { createUiMascot } from "./ui/mascot.js";
import { createChatMessages } from "./chat/messages.js";
import { createChatComposer } from "./chat/composer.js";

const state = createState();
const actions: AppActions = {
...createUiRender(),
...createChatAttachments(state),
...createDirectChat(state, () => actions),
...createApiEvents(state, () => actions),
...createUiStatus(state, () => actions),
...createUiMascot(state),
...createChatMessages(state, () => actions),
...createConversationCards(state, () => actions),
...createChatComposer(state, () => actions)
};
// --- 倒计时时钟（每秒更新一次定时提醒面板和小 D 倒计时文案） ---
function startTimerTick() {
    if (state.timerTickInterval)
        clearInterval(state.timerTickInterval);
    state.timerTickInterval = setInterval(() => {
        const mascotCard = document.getElementById('mascot-card')!;
        if (mascotCard && mascotCard.getAttribute('data-state') === 'reminder') {
            actions.updateMascotState();
        }
    }, 1000);
}

// --- 事件监听与初始化 ---
window.addEventListener('DOMContentLoaded', () => {
    actions.initializeConversationCards();
    actions.setupMascotSvgs();
    actions.fetchServerInfo();
    if (window.location.hash) history.replaceState(null, '', window.location.pathname + window.location.search);
    actions.connectDirectChat().catch(() => showToast('暂时连不上小 D，发送消息时会重试。', 'error'));
    startTimerTick();
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
            textarea.style.height = textarea.scrollHeight + 'px';
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
    actions.updateSendButtonState();
    const more = document.getElementById('chat-more') as HTMLDetailsElement;
    more.addEventListener('click', event => {
        if ((event.target as Element).closest('button')) more.open = false;
    });
    document.addEventListener('click', event => {
        if (!more.contains(event.target as Node)) more.open = false;
    });
    document.addEventListener('keydown', event => {
        if (event.key === 'Escape' && more.open) {
            more.open = false;
            more.querySelector('summary')!.focus();
        }
    });
});

// 显式挂载到 window，确保 inline onclick 与外部完全兼容
window.submitMessage = actions.submitMessage;

window.abortCurrentTask = actions.abortCurrentTask;

window.insertExamplePrompt = actions.insertExamplePrompt;

window.triggerFileInput = actions.triggerFileInput;

window.removePendingAttachment = actions.removePendingAttachment;

window.showToast = showToast;
declare global { interface Window {
submitMessage: AppActions["submitMessage"];
abortCurrentTask: AppActions["abortCurrentTask"];
insertExamplePrompt: AppActions["insertExamplePrompt"];
triggerFileInput: AppActions["triggerFileInput"];
removePendingAttachment: AppActions["removePendingAttachment"];
showToast: typeof showToast;
__liveLogged?: boolean;
} }
