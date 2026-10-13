import { renderToolFailure } from "./tool-cards.js";
import type { BrowserView } from "../types.js";
import { escapeHtml, formatFileSize } from "../ui/format.js";
import { renderMarkdown } from "./markdown.js";
import { extractLiveInfo } from "./live.js";
import type { AppState, AppActions } from "../state.js";

export function createChatMessages(state: AppState, getActions: () => Pick<AppActions, "updateBusyControls" | "updateConversationCards" | "updateMascotState" | "patchChildren">) {
// =========================================================
// 渲染主函数
// =========================================================
function renderView(view: BrowserView) {
    const chatEl = document.getElementById('messages-container')!;
    const history = document.getElementById('message-history')!;
    if (!chatEl)
        return;
    // 先画到离屏节点，最后只把变化补到页面上
    const container = document.createElement('div');
    const isNearBottom = chatEl.scrollHeight - chatEl.scrollTop - chatEl.clientHeight < 80;
    // 没有历史消息时，由小 D 打个招呼。
    const hasRenderableEntries = Array.isArray(view.entries) && view.entries.some(e => {
        if (e.kind === 'assistant') {
            const hasText = !!(e.text && e.text.trim());
            const hasError = !!e.error;
            return hasText || hasError;
        }
        if (e.kind === 'user') {
            const hasText = !!(e.text && e.text.trim());
            const hasAttachments = Array.isArray(e.attachments) && e.attachments.length > 0;
            return hasText || hasAttachments;
        }
        return !!e.isError;
    });
    const isBusy = !!view.busy || (view.live && Object.keys(view.live).length > 0);
    if (!hasRenderableEntries && !isBusy) {
        renderEmptyConversation(container);
    }
    // 3. 渲染历史 Entry
    if (Array.isArray(view.entries)) {
        for (let i = 0; i < view.entries.length; i++) {
            const entry = view.entries[i];
            if (entry.kind === 'user') {
                const rawText = entry.text || '';
                // 以 [定时提醒] 开头的用户消息：显示为居中的 ⏰ 提醒系统卡片
                if (/^\[(定时提醒|计划任务|后台任务结果)\]/.test(rawText)) {
                    const row = document.createElement('div');
                    row.className = 'message-row reminder-system-row';
                    const cleanText = rawText.replace(/^\[(定时提醒|计划任务|后台任务结果)\]\s*/, '');
                    row.innerHTML = `
                <div class="reminder-system-card">
                  <span class="reminder-system-icon">⏰</span>
                  <div class="reminder-system-text">${escapeHtml(cleanText)}</div>
                </div>
              `;
                    container.appendChild(row);
                }
                else {
                    // 普通用户消息
                    const hasAttachments = Array.isArray(entry.attachments) && entry.attachments.length > 0;
                    const hasText = !!(rawText && rawText.trim());
                    let attachmentsHtml = '';
                    if (hasAttachments) {
                        attachmentsHtml = '<div class="user-attachments-grid">';
                        for (const att of entry.attachments!) {
                            if (att.kind === 'image' && att.url) {
                                attachmentsHtml += `
                      <a href="${escapeHtml(att.url)}" target="_blank" rel="noopener noreferrer" class="msg-image-link" title="点击查看大图：${escapeHtml(att.name)}">
                        <img class="msg-image-thumb" src="${escapeHtml(att.url)}" alt="${escapeHtml(att.name)}" loading="lazy">
                      </a>
                    `;
                            }
                            else {
                                attachmentsHtml += `
                      <div class="msg-file-card" title="${escapeHtml(att.name)}">
                        <span class="msg-file-icon">📄</span>
                        <div class="msg-file-details">
                          <span class="msg-file-name">${escapeHtml(att.name)}</span>
                          <span class="msg-file-size">${escapeHtml(formatFileSize(att.size || 0))}</span>
                        </div>
                      </div>
                    `;
                            }
                        }
                        attachmentsHtml += '</div>';
                    }
                    const row = document.createElement('div');
                    row.className = 'message-row user-row';
                    row.innerHTML = `
                <div class="user-bubble ${!hasText && hasAttachments ? 'attachments-only' : ''}">
                  ${hasAttachments ? attachmentsHtml : ''}
                  ${hasText ? `<div class="user-text-body">${escapeHtml(rawText)}</div>` : ''}
                </div>
              `;
                    container.appendChild(row);
                }
            }
            else if (entry.kind === 'assistant') {
                if (entry.error) {
                    const errorMsg = entry.error;
                    let count = 1;
                    while (i + 1 < view.entries.length &&
                        view.entries[i + 1].kind === 'assistant' &&
                        view.entries[i + 1].error === errorMsg) {
                        count++;
                        i++;
                    }
                    const row = document.createElement('div');
                    row.className = 'message-row error-system-row';
                    const countBadge = count > 1 ? ` <span class="error-count-badge">×${count}</span>` : '';
                    row.innerHTML = `
                <div class="error-system-card">
                  <div class="error-system-main">
                    <span>模型调用失败：${escapeHtml(errorMsg)}</span>${countBadge}
                  </div>
                  <div class="error-system-sub">可以稍后重发，或检查模型服务</div>
                </div>
              `;
                    container.appendChild(row);
                }
                else {
                    const hasText = !!(entry.text && entry.text.trim());
                    if (!hasText) continue;
                    const row = document.createElement('div');
                    row.className = 'message-row assistant-row';
                    let assistantHtml = '<div class="assistant-wrapper">';
                    if (hasText) {
                        assistantHtml += `<div class="assistant-bubble md">${renderMarkdown(entry.text)}</div>`;
                    }
                    assistantHtml += '</div>';
                    row.innerHTML = assistantHtml;
                    container.appendChild(row);
                }
            }
            else if (entry.kind === 'tool' && entry.isError) {
                const row = document.createElement('div');
                row.className = 'message-row error-system-row';
                row.innerHTML = renderToolFailure(entry);
                container.appendChild(row);
            }
        }
    }
    // 4. 运行中状态（busy / live）
    getActions().updateBusyControls(isBusy, view.inbox || 0);
    if (isBusy) {
        const liveInfo = extractLiveInfo(view.live);
        if (liveInfo?.text) {
            const row = document.createElement('div');
            row.className = 'message-row assistant-row';
            row.innerHTML = `<div class="assistant-wrapper"><div class="assistant-bubble md">${renderMarkdown(liveInfo.text)}<span class="cursor-blink"></span></div></div>`;
            container.appendChild(row);
        }
    }
    // 7. 更新吉祥物小 D 状态
    getActions().updateMascotState();
    getActions().patchChildren(history, container);
    getActions().updateConversationCards();
    // 自动滚到底部
    if (isNearBottom || state.autoScrollChat) {
        chatEl.scrollTop = chatEl.scrollHeight;
    }
}

// 首次打开时显示一句问候。
function renderEmptyConversation(container: HTMLElement) {
    const wrap = document.createElement('div');
    wrap.className = 'message-row assistant-row empty-chat-state';
    wrap.innerHTML = '<div class="assistant-bubble md"><p>我在。今天想聊点什么？</p></div>';
    container.appendChild(wrap);
}

return { renderEmptyConversation, renderView };
}
