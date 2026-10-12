import type { BrowserView, RunningTool, ToolArgs, ViewEntry } from "../types.js";
import { escapeHtml, formatFileSize, formatUsageTokens, getLastNonEmptyLine, formatToolArgs } from "../ui/format.js";
import { renderMarkdown } from "./markdown.js";
import { extractLiveInfo } from "./live.js";
import type { AppState, AppActions } from "../state.js";

export function createChatMessages(state: AppState, getActions: () => Pick<AppActions, "fetchConversations" | "updateBusyControls" | "renderNotes" | "renderReminders" | "renderTasks" | "updateMascotState" | "patchChildren">) {
// =========================================================
// 渲染主函数
// =========================================================
function renderView(view: BrowserView) {
    const chatEl = document.getElementById('messages-container')!;
    if (!chatEl)
        return;
    // 先画到离屏节点，最后只把变化补到页面上
    const container = document.createElement('div');
    const isNearBottom = chatEl.scrollHeight - chatEl.scrollTop - chatEl.clientHeight < 80;
    // 1. 处理子 Agent 会话顶部提示
    const parentBanner = document.getElementById('subagent-parent-banner')!;
    if (parentBanner) {
        if (view.parentId) {
            parentBanner.style.display = 'flex';
            const link = (document.getElementById('subagent-back-link') as HTMLAnchorElement);
            if (link)
                link.setAttribute('data-parent-id', String(view.parentId));
        }
        else {
            parentBanner.style.display = 'none';
        }
    }
    // 2. 空会话：显示 4 个示例引导按钮
    const hasRenderableEntries = Array.isArray(view.entries) && view.entries.some(e => {
        if (e.kind === 'assistant') {
            const hasText = !!(e.text && e.text.trim());
            const hasToolCalls = Array.isArray(e.toolCalls) && e.toolCalls.length > 0;
            const hasError = !!e.error;
            return hasText || hasToolCalls || hasError;
        }
        if (e.kind === 'user') {
            const hasText = !!(e.text && e.text.trim());
            const hasAttachments = Array.isArray(e.attachments) && e.attachments.length > 0;
            return hasText || hasAttachments;
        }
        return true;
    });
    const isBusy = !!view.busy || (view.live && Object.keys(view.live).length > 0);
    if (!hasRenderableEntries && !isBusy) {
        renderEmptyConversation(container);
    }
    // 5. 会话列表标题刷新：当前会话的 view 里第一次出现 user 消息时拉取
    const hasUserMsg = Array.isArray(view.entries) && view.entries.some(e => e.kind === 'user');
    if (hasUserMsg && state.currentConversationId && !state.seenUserMessageConvs.has(String(state.currentConversationId))) {
        state.seenUserMessageConvs.add(String(state.currentConversationId));
        getActions().fetchConversations();
    }
    // 建立工具执行结果映射
    const toolResultsMap = new Map<string, ViewEntry>();
    if (Array.isArray(view.entries)) {
        for (const entry of view.entries) {
            if (entry.kind === 'tool' && entry.toolCallId) {
                toolResultsMap.set(String(entry.toolCallId), entry);
            }
        }
    }
    // 建立 live 工具运行槽映射 (按 callId 索引)
    const liveToolsMap = new Map<string, RunningTool>();
    if (view.live && Array.isArray(view.live.tools)) {
        for (const slot of view.live.tools) {
            if (slot && slot.callId) {
                liveToolsMap.set(String(slot.callId), slot);
            }
        }
    }
    const renderedToolCallIds = new Set();
    // 3. 渲染历史 Entry
    if (Array.isArray(view.entries)) {
        for (let i = 0; i < view.entries.length; i++) {
            const entry = view.entries[i];
            if (entry.kind === 'user') {
                const rawText = entry.text || '';
                // 以 [定时提醒] 开头的用户消息：显示为居中的 ⏰ 提醒系统卡片
                if (rawText.startsWith('[定时提醒]')) {
                    const row = document.createElement('div');
                    row.className = 'message-row reminder-system-row';
                    const cleanText = rawText.replace(/^\[定时提醒\]\s*/, '');
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
                <button class="fork-btn" title="从这里分叉" onclick="forkConversation('${escapeHtml(entry.id)}')">
                  <span>⑂ 从这里分叉</span>
                </button>
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
                    const hasToolCalls = Array.isArray(entry.toolCalls) && entry.toolCalls.length > 0;
                    // 没有 text、没有 toolCalls、也没有 error 的 assistant 条目不渲染空气泡
                    if (!hasText && !hasToolCalls) {
                        continue;
                    }
                    const row = document.createElement('div');
                    row.className = 'message-row assistant-row';
                    let assistantHtml = '<div class="assistant-wrapper">';
                    if (hasText) {
                        assistantHtml += `<div class="assistant-bubble md">${renderMarkdown(entry.text)}</div>`;
                    }
                    // 附带的工具调用卡片（含 delegate 子 Agent）
                    if (hasToolCalls) {
                        for (const call of entry.toolCalls!) {
                            renderedToolCallIds.add(String(call.id));
                            const result = toolResultsMap.get(String(call.id));
                            const runningSlot = liveToolsMap.get(String(call.id));
                            assistantHtml += renderToolCardHtml(call.name, call.args, result, view.subagents, runningSlot);
                        }
                    }
                    assistantHtml += '</div>';
                    row.innerHTML = assistantHtml;
                    container.appendChild(row);
                }
            }
            else if (entry.kind === 'tool') {
                if (!renderedToolCallIds.has(String(entry.toolCallId))) {
                    const row = document.createElement('div');
                    row.className = 'message-row assistant-row';
                    row.innerHTML = `
                <div class="assistant-wrapper">
                  ${renderToolCardHtml(entry.name || '工具调用', null, entry, view.subagents)}
                </div>
              `;
                    container.appendChild(row);
                }
            }
        }
    }
    // 4. 运行中状态（busy / live）
    getActions().updateBusyControls(isBusy, view.inbox || 0);
    if (isBusy) {
        const liveInfo = extractLiveInfo(view.live);
        const hasRunningTools = !!(liveInfo && Array.isArray(liveInfo.runningTools) && liveInfo.runningTools.length > 0);
        const hasLiveGeneration = !!(view.live && view.live.generation);
        // 3. 有工具在运行时，不要再显示“正在思考…”气泡；只有 live.generation 存在且没有工具在运行时才显示。
        const showThinkingBubble = hasLiveGeneration && !hasRunningTools;
        // 过滤掉已经在 assistant toolCall 中渲染过的运行中工具卡片
        const unrenderedRunningTools = hasRunningTools
            ? liveInfo.runningTools.filter(t => !t.callId || !renderedToolCallIds.has(String(t.callId)))
            : [];
        const hasLiveText = !!(liveInfo && liveInfo.text);
        const hasThinkingText = !!(showThinkingBubble && liveInfo && liveInfo.thinking);
        const shouldRenderLiveRow = hasLiveText || hasThinkingText || showThinkingBubble || unrenderedRunningTools.length > 0;
        if (shouldRenderLiveRow) {
            const liveRow = document.createElement('div');
            liveRow.className = 'message-row assistant-row';
            let liveInner = '<div class="assistant-wrapper">';
            if (hasLiveText) {
                liveInner += `
              <div class="assistant-bubble md">${renderMarkdown(liveInfo.text)}<span class="cursor-blink"></span></div>
            `;
            }
            else if (showThinkingBubble) {
                if (hasThinkingText) {
                    liveInner += `
                <div class="live-bubble">
                  💭 正在思考：${escapeHtml(liveInfo.thinking)}<span class="cursor-blink"></span>
                </div>
              `;
                }
                else {
                    liveInner += `
                <div class="live-bubble">
                  <span class="thinking-dots">正在思考<span>.</span><span>.</span><span>.</span></span>
                </div>
              `;
                }
            }
            if (unrenderedRunningTools.length > 0) {
                for (const t of unrenderedRunningTools) {
                    liveInner += renderRunningToolCardHtml(t.name, t.args, t.output);
                }
            }
            liveInner += '</div>';
            liveRow.innerHTML = liveInner;
            container.appendChild(liveRow);
        }
    }
    // 5. 渲染侧边栏各面板
    getActions().renderNotes(view.notes);
    getActions().renderReminders(view.reminders);
    getActions().renderTasks(view.tasks);
    // 6. 渲染 Token 用量
    const tokenEl = document.getElementById('stat-tokens')!;
    if (tokenEl) {
        tokenEl.textContent = formatUsageTokens(view.usage);
    }
    // 7. 更新吉祥物小 D 状态
    getActions().updateMascotState();
    getActions().patchChildren(chatEl, container);
    // 自动滚到底部
    if (isNearBottom || state.autoScrollChat) {
        chatEl.scrollTop = chatEl.scrollHeight;
    }
}

// 渲染空会话示例按钮
function renderEmptyConversation(container: HTMLElement) {
    const wrap = document.createElement('div');
    wrap.className = 'empty-chat-state';
    wrap.innerHTML = `
        <div class="empty-chat-badge">✨ Pi Durable Agent</div>
        <h2 class="empty-chat-title">开始与你的 Durable 助手对话</h2>
        <p class="empty-chat-desc">支持持久化存储、断点恢复、定时提醒与子 Agent 协同。点击下方预置任务立即体验：</p>
        <div class="example-prompts-grid">
          <div class="example-prompt-card" onclick="insertExamplePrompt('帮我看看 https://pi.dev 首页讲了什么，抓完等 20 秒再总结')">
            <div class="example-prompt-main">帮我看看 https://pi.dev 首页讲了什么，抓完等 20 秒再总结</div>
            <div class="example-prompt-sub">⚡ 演示断点恢复，等待时点模拟崩溃</div>
          </div>
          <div class="example-prompt-card" onclick="insertExamplePrompt('2 分钟后提醒我站起来活动一下')">
            <div class="example-prompt-main">2 分钟后提醒我站起来活动一下</div>
            <div class="example-prompt-sub">⏰ 演示后台提醒，关掉网页也会提醒</div>
          </div>
          <div class="example-prompt-card" onclick="insertExamplePrompt('派一个子 Agent 去看看 https://earendil.com 有什么新文章，再告诉我')">
            <div class="example-prompt-main">派一个子 Agent 去看看 https://earendil.com 有什么新文章，再告诉我</div>
            <div class="example-prompt-sub">🤖 演示子 Agent 独立协作</div>
          </div>
          <div class="example-prompt-card" onclick="insertExamplePrompt('记住：我喜欢简洁、带要点的回答')">
            <div class="example-prompt-main">记住：我喜欢简洁、带要点的回答</div>
            <div class="example-prompt-sub">📝 演示 Document 持久记忆</div>
          </div>
        </div>
      `;
    container.appendChild(wrap);
}

// 工具卡片构造（支持 delegate 子 Agent 样式与实时 runningSlot 输出）
function renderToolCardHtml(name: string, args: ToolArgs | null, result: ViewEntry | undefined, subagents: BrowserView["subagents"], runningSlot?: RunningTool) {
    const isDone = !!result;
    const isError = result && !!result.isError;
    const resultText = result ? (result.text || '') : '';
    const isLong = resultText.length > 200;
    const previewText = isLong ? resultText.slice(0, 200) + '…' : resultText;
    const isSubagent = (name === 'delegate');
    const runningOutput = runningSlot ? getLastNonEmptyLine(runningSlot.output) : '';
    // 子 Agent 专用卡片样式
    if (isSubagent) {
        let taskDesc = args && args.task ? args.task : '';
        let targetConvId: string | number | null = null;
        // 从 subagents 列表或结果寻找对应的子会话 ID
        if (Array.isArray(subagents)) {
            const match = subagents.find(s => s.task === taskDesc || (s.task && taskDesc && s.task.includes(taskDesc)));
            if (match)
                targetConvId = match.conversationId;
            if (!targetConvId && subagents.length > 0) {
                targetConvId = subagents[subagents.length - 1].conversationId;
            }
        }
        if (!targetConvId && resultText) {
            const m = resultText.match(/会话\s*#?(\d+)/) || resultText.match(/conversationId["':\s]+(\d+)/);
            if (m)
                targetConvId = m[1];
        }
        const badgeClass = isError ? 'badge error' : (isDone ? 'badge done' : 'badge running');
        const badgeText = isError ? '执行失败' : (isDone ? '已完成' : '运行中');
        return `
          <div class="tool-card subagent-card ${isError ? 'error' : ''}">
            <div class="tool-card-header">
              <span class="tool-name-tag">🤖 子 Agent</span>
              <span class="tool-badge ${badgeClass}">${badgeText}</span>
            </div>
            ${taskDesc ? `<div style="font-size:13px; font-weight:500;">任务：${escapeHtml(taskDesc)}</div>` : ''}
            ${targetConvId ? `
              <div>
                <a class="subagent-jump-link" href="#${targetConvId}" onclick="selectConversation('${targetConvId}')">
                  查看子 Agent 对话 →
                </a>
              </div>
            ` : ''}
            ${isDone ? `
              <div class="tool-result-box">
                <div class="tool-result-content" id="tool-text-${escapeHtml(result.id || Math.random())}">${escapeHtml(previewText)}</div>
                ${isLong ? `
                  <button
                    class="tool-expand-btn"
                    data-full="${escapeHtml(resultText)}"
                    data-preview="${escapeHtml(previewText)}"
                    onclick="toggleToolResultExpand(this)"
                  >展开全文（共 ${resultText.length} 字）</button>
                ` : ''}
              </div>
            ` : `
              <div class="tool-result-box" style="color: ${runningOutput ? 'var(--primary)' : 'var(--text-muted)'}; font-size: 12.5px;">
                ${escapeHtml(runningOutput || '正在执行…')}
              </div>
            `}
          </div>
        `;
    }
    // 普通工具卡片
    const badgeClass = isError ? 'badge error' : (isDone ? 'badge done' : 'badge running');
    const badgeText = isError ? '执行失败' : (isDone ? '已完成' : '运行中');
    return `
        <div class="tool-card ${isError ? 'error' : ''}">
          <div class="tool-card-header">
            <span class="tool-name-tag">🛠️ ${escapeHtml(name)}</span>
            <span class="tool-badge ${badgeClass}">${badgeText}</span>
          </div>
          ${args ? `<div class="tool-args-box">${escapeHtml(formatToolArgs(args))}</div>` : ''}
          ${isDone ? `
            <div class="tool-result-box">
              <div class="tool-result-content" id="tool-text-${escapeHtml(result.id || Math.random())}">${escapeHtml(previewText)}</div>
              ${isLong ? `
                <button
                  class="tool-expand-btn"
                  data-full="${escapeHtml(resultText)}"
                  data-preview="${escapeHtml(previewText)}"
                  onclick="toggleToolResultExpand(this)"
                >展开全文（共 ${resultText.length} 字）</button>
              ` : ''}
            </div>
          ` : `
            <div class="tool-result-box" style="color: ${runningOutput ? 'var(--primary)' : 'var(--text-muted)'}; font-size: 12.5px;">
              ${escapeHtml(runningOutput || '正在执行…')}
            </div>
          `}
        </div>
      `;
}

function renderRunningToolCardHtml(name: string, args: ToolArgs | undefined, output?: string) {
    const lastLine = getLastNonEmptyLine(output);
    return `
        <div class="tool-card">
          <div class="tool-card-header">
            <span class="tool-name-tag">⚙️ ${escapeHtml(name)}</span>
            <span class="tool-badge running">运行中</span>
          </div>
          ${args ? `<div class="tool-args-box">${escapeHtml(formatToolArgs(args))}</div>` : ''}
          <div class="tool-result-box" style="color: var(--primary); font-size: 12.5px;">
            ${escapeHtml(lastLine || '执行中…')}
          </div>
        </div>
      `;
}

function toggleToolResultExpand(btn: HTMLButtonElement) {
    const contentEl = btn.previousElementSibling!;
    const fullText = btn.getAttribute('data-full')!;
    const previewText = btn.getAttribute('data-preview');
    const isExpanded = btn.getAttribute('data-expanded') === 'true';
    if (isExpanded) {
        contentEl.textContent = previewText;
        btn.textContent = `展开全文（共 ${fullText.length} 字）`;
        btn.setAttribute('data-expanded', 'false');
    }
    else {
        contentEl.textContent = fullText;
        btn.textContent = '收起';
        btn.setAttribute('data-expanded', 'true');
    }
}
return { renderEmptyConversation, renderView, toggleToolResultExpand };
}
