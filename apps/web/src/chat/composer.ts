import { sendMessage, abortConversation } from "../api/chat.js";
import { generateUuid } from "../ui/format.js";
import { showToast } from "../ui/toast.js";
import type { AppState, AppActions } from "../state.js";

export function createChatComposer(state: AppState, getActions: () => Pick<AppActions, "updateSendButtonState" | "connectDirectChat" | "removePendingAttachment">) {
  function insertExamplePrompt(text: string) {
    const textarea = document.getElementById("chat-textarea") as HTMLTextAreaElement;
    textarea.value = text;
    textarea.style.height = "auto";
    textarea.style.height = textarea.scrollHeight + "px";
    textarea.focus();
    getActions().updateSendButtonState();
  }

  function updateBusyControls(isBusy: boolean, inboxCount: number) {
    document.getElementById("btn-abort")!.style.display = isBusy ? "inline-flex" : "none";
    const badge = document.getElementById("inbox-badge")!;
    badge.textContent = inboxCount > 0 ? "收到，马上接着说" : "";
    badge.style.display = inboxCount > 0 ? "inline-block" : "none";
  }

  async function submitMessage() {
    if (state.isSending) return;
    const textarea = document.getElementById("chat-textarea") as HTMLTextAreaElement;
    const text = textarea.value.trim();
    if (!text && state.pendingAttachments.length === 0) return;
    const sentAttachments = [...state.pendingAttachments];
    const attachments = sentAttachments.map(({ name, mimeType, data }) => ({ name, mimeType, data }));
    const button = document.getElementById("btn-send") as HTMLButtonElement;
    state.isSending = true;
    button.disabled = true;
    button.ariaBusy = "true";
    button.ariaLabel = "正在发送";
    try {
      await getActions().connectDirectChat();
      if (state.currentConversationId === null) throw new Error("还没有连接上小 D");
      // 新消息在当前工具轮结束后加入回复，用户不必选择插话或新话题。
      await sendMessage(state.currentConversationId, { text, requestId: generateUuid(), mode: "steer", attachments });
      if (textarea.value.trim() === text) {
        textarea.value = "";
        textarea.style.height = "auto";
      }
      for (let i = state.pendingAttachments.length - 1; i >= 0; i--) {
        if (sentAttachments.includes(state.pendingAttachments[i])) getActions().removePendingAttachment(i);
      }
    } catch (error) {
      showToast("发送失败：" + (error instanceof Error ? error.message : String(error)), "error");
    } finally {
      state.isSending = false;
      button.ariaBusy = "false";
      button.ariaLabel = "发送消息";
      getActions().updateSendButtonState();
    }
  }

  async function abortCurrentTask() {
    if (!state.currentConversationId) return;
    try { await abortConversation(state.currentConversationId); }
    catch { showToast("暂时没能停止回复，请重试。", "error"); }
  }
  return { updateBusyControls, submitMessage, abortCurrentTask, insertExamplePrompt };
}
