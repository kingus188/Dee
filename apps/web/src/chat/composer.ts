import { sendMessage, abortConversation } from "../api/chat.js";
import { generateUuid } from "../ui/format.js";
import { showToast } from "../ui/toast.js";
import type { AppState, AppActions } from "../state.js";

export function createChatComposer(state: AppState, getActions: () => Pick<AppActions, "updateSendButtonState" | "createNewConversation" | "clearPendingAttachments" | "fetchConversations">) {
function insertExamplePrompt(text: string) {
    const textarea = (document.getElementById('chat-textarea') as HTMLTextAreaElement);
    if (textarea) {
        textarea.value = text;
        textarea.style.height = 'auto';
        textarea.style.height = Math.min(textarea.scrollHeight, 140) + 'px';
        textarea.focus();
    }
    getActions().updateSendButtonState();
}

// 忙碌状态控制
function updateBusyControls(isBusy: boolean, inboxCount: number) {
    const steerToggle = document.getElementById('steer-toggle')!;
    const btnAbort = (document.getElementById('btn-abort') as HTMLButtonElement);
    const inboxBadge = document.getElementById('inbox-badge')!;
    if (steerToggle) {
        steerToggle.style.display = isBusy ? 'inline-flex' : 'none';
    }
    if (btnAbort) {
        btnAbort.style.display = isBusy ? 'inline-flex' : 'none';
    }
    if (inboxBadge) {
        if (inboxCount > 0) {
            inboxBadge.textContent = `排队中：${inboxCount} 条`;
            inboxBadge.style.display = 'inline-block';
        }
        else {
            inboxBadge.style.display = 'none';
        }
    }
}

// --- 消息发送与交互 ---
async function submitMessage() {
    if (state.isSending)
        return;
    const textarea = (document.getElementById('chat-textarea') as HTMLTextAreaElement);
    const text = (textarea ? textarea.value : '').trim();
    if (!text && state.pendingAttachments.length === 0)
        return;
    if (!state.currentConversationId) {
        await getActions().createNewConversation();
        if (!state.currentConversationId)
            return;
    }
    const steerCheckbox = (document.getElementById('steer-checkbox') as HTMLInputElement);
    const mode = steerCheckbox && steerCheckbox.checked ? 'steer' : 'followUp';
    const requestId = generateUuid();
    const btnSend = (document.getElementById('btn-send') as HTMLButtonElement);
    state.isSending = true;
    if (btnSend) {
        btnSend.disabled = true;
        btnSend.textContent = '发送中…';
    }
    const attachmentsPayload = state.pendingAttachments.map(att => ({
        name: att.name,
        mimeType: att.mimeType,
        data: att.data,
    }));
    try {
        await sendMessage(state.currentConversationId, { text, requestId, mode, attachments: attachmentsPayload });
        // 成功后清空输入框与待发送附件
        if (textarea) {
            textarea.value = '';
            textarea.style.height = 'auto';
        }
        getActions().clearPendingAttachments();
        getActions().fetchConversations();
    }
    catch (err) {
        showToast('发送失败：' + (err instanceof Error ? err.message : String(err)), 'error');
        // 出错时保留输入框内容和待发送附件，方便重试
    }
    finally {
        state.isSending = false;
        if (btnSend) {
            btnSend.textContent = '发送';
            getActions().updateSendButtonState();
        }
    }
}

async function abortCurrentTask() {
    if (!state.currentConversationId)
        return;
    try {
        await abortConversation(state.currentConversationId);
    }
    catch (err) {
        alert('停止失败：' + (err instanceof Error ? err.message : String(err)));
    }
}
return { updateBusyControls, submitMessage, abortCurrentTask, insertExamplePrompt };
}
