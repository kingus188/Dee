import { formatTime, formatListTime } from "../ui/format.js";
import type { AppState, AppActions } from "../state.js";

export function createConversationsList(state: AppState, getActions: () => Pick<AppActions, "stagingFor">) {
function updateConversationHeaders() {
    const current = state.conversations.find(c => String(c.id) === String(state.currentConversationId));
    let title = state.currentConversationId ? '新对话' : '未选择对话';
    if (current) {
        title = current.forkOf ? `⑂ ${current.title}` : current.title;
    }
    else if (state.currentViewData && state.currentViewData.parentId) {
        title = `子 Agent 会话 #${state.currentConversationId}`;
    }
    const desktopTitleEl = document.getElementById('desktop-current-title')!;
    const mobileTitleEl = document.getElementById('mobile-current-title')!;
    const desktopMetaEl = document.getElementById('desktop-current-meta')!;
    if (desktopTitleEl)
        desktopTitleEl.textContent = title;
    if (mobileTitleEl)
        mobileTitleEl.textContent = title;
    if (desktopMetaEl) {
        desktopMetaEl.textContent = current?.createdAt ? formatTime(current.createdAt) : '';
    }
}

function syncConversationTabs() {
    const activeCount = state.conversations.filter((c) => !c.archivedAt).length;
    const archivedCount = state.conversations.length - activeCount;
    const activeBtn = (document.getElementById('conv-tab-active') as HTMLButtonElement);
    const archivedBtn = (document.getElementById('conv-tab-archived') as HTMLButtonElement);
    const activeNum = document.getElementById('conv-count-active')!;
    const archivedNum = document.getElementById('conv-count-archived')!;
    if (activeNum)
        activeNum.textContent = String(activeCount);
    if (archivedNum)
        archivedNum.textContent = String(archivedCount);
    const archivedOn = state.conversationView === 'archived';
    if (activeBtn) {
        activeBtn.classList.toggle('is-on', !archivedOn);
        activeBtn.setAttribute('aria-selected', archivedOn ? 'false' : 'true');
    }
    if (archivedBtn) {
        archivedBtn.classList.toggle('is-on', archivedOn);
        archivedBtn.setAttribute('aria-selected', archivedOn ? 'true' : 'false');
    }
    return { activeCount, archivedCount };
}

function makeConvButton(action: string, label: string, title?: string, danger?: boolean) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'conv-action' + (danger ? ' conv-action-danger' : '');
    button.dataset.action = action;
    button.textContent = label;
    if (title)
        button.title = title;
    return button;
}

function renderConversationList() {
    const listEl = getActions().stagingFor('conversation-list');
    const { archivedCount } = syncConversationTabs();
    if (!listEl)
        return;
    const archivedOn = state.conversationView === 'archived';
    const realList = document.getElementById('conversation-list')!;
    if (realList)
        realList.classList.toggle('is-archived-view', archivedOn);
    const visible = state.conversations.filter((c) => archivedOn ? !!c.archivedAt : !c.archivedAt);
    if (visible.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'conv-empty';
        empty.textContent = archivedOn
            ? '还没有归档的对话。'
            : (archivedCount > 0 ? `当前没有对话。归档里还有 ${archivedCount} 个。` : '当前没有对话。');
        listEl.appendChild(empty);
        return;
    }
    visible.forEach((c) => {
        const item = document.createElement('article');
        const isActive = String(c.id) === String(state.currentConversationId);
        const confirming = state.pendingRemoveId === String(c.id);
        item.className = 'conversation-item' + (isActive ? ' active' : '') + (confirming ? ' is-confirming' : '');
        item.dataset.id = String(c.id);
        const open = document.createElement('button');
        open.type = 'button';
        open.className = 'conv-open';
        open.dataset.action = 'open';
        const titleRow = document.createElement('span');
        titleRow.className = 'conv-title-row';
        const isFork = !!c.forkOf || (c.title && c.title.startsWith('分叉'));
        if (isFork) {
            const fork = document.createElement('span');
            fork.className = 'conv-fork-icon';
            fork.textContent = '⑂';
            titleRow.appendChild(fork);
        }
        const title = document.createElement('span');
        title.className = 'conv-title';
        title.textContent = c.title || '新对话';
        titleRow.appendChild(title);
        const stamp = archivedOn ? (c.archivedAt || c.createdAt) : c.createdAt;
        const time = document.createElement('span');
        time.className = 'conv-time';
        time.textContent = formatListTime(stamp);
        time.title = formatTime(stamp);
        open.appendChild(titleRow);
        open.appendChild(time);
        item.appendChild(open);
        if (confirming) {
            const confirm = document.createElement('div');
            confirm.className = 'conv-confirm';
            const note = document.createElement('p');
            note.textContent = '只从列表移除，本机记录还在。确定？';
            const actions = document.createElement('div');
            actions.className = 'conv-actions';
            actions.appendChild(makeConvButton('cancel-remove', '取消', '留在列表里'));
            actions.appendChild(makeConvButton('confirm-remove', '删除', '只从列表移除，本机记录还在', true));
            confirm.appendChild(note);
            confirm.appendChild(actions);
            item.appendChild(confirm);
        }
        else {
            const actions = document.createElement('div');
            actions.className = 'conv-actions';
            if (archivedOn) {
                actions.appendChild(makeConvButton('restore', '恢复', '放回当前列表。已停掉的提醒和计划不会自动恢复。'));
            }
            else {
                actions.appendChild(makeConvButton('archive', '归档', '从当前列表收起，并停掉未完成的提醒和计划'));
            }
            actions.appendChild(makeConvButton('remove', '删除', '只从列表移除，本机记录还在', true));
            item.appendChild(actions);
        }
        listEl.appendChild(item);
    });
}
return { renderConversationList, updateConversationHeaders };
}
