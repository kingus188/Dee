import { listConversations, createConversation, postShelf, forkFromEntry } from "../api/conversations.js";
import { showToast } from "../ui/toast.js";
import type { AppState, AppActions } from "../state.js";

export function createConversationsController(state: AppState, getActions: () => Pick<AppActions, "renderConversationList" | "updateConversationHeaders" | "closeSidebarDrawer" | "connectSse" | "renderEmptyConversation" | "patchChildren" | "renderNotes" | "renderReminders" | "renderTasks" | "updateBusyControls">) {
async function fetchConversations(isInitial = false) {
    try {
        state.conversations = await listConversations();
        if (state.pendingRemoveId && !state.conversations.some((c) => String(c.id) === state.pendingRemoveId))
            state.pendingRemoveId = null;
        // 只在第一次进入时自动打开。之后用户把当前对话清空，10 秒刷新不能再偷偷建一条。
        if (isInitial) {
            const hashId = parseHashConversationId();
            if (hashId !== null) {
                const hashed = state.conversations.find((c) => String(c.id) === String(hashId));
                if (hashed?.archivedAt)
                    state.conversationView = 'archived';
                getActions().renderConversationList();
                getActions().updateConversationHeaders();
                if (String(state.currentConversationId) !== String(hashId))
                    selectConversation(hashId);
                return true;
            }
            const firstActive = state.conversations.find((c) => !c.archivedAt);
            if (firstActive) {
                getActions().renderConversationList();
                getActions().updateConversationHeaders();
                selectConversation(firstActive.id);
                return true;
            }
            if (state.conversations.length === 0) {
                await createNewConversation();
                return true;
            }
            state.conversationView = 'active';
            getActions().renderConversationList();
            getActions().updateConversationHeaders();
            clearOpenConversation();
            return true;
        }
        getActions().renderConversationList();
        getActions().updateConversationHeaders();
        return true;
    }
    catch (err) {
        console.error('拉取会话列表出错:', err);
        return false;
    }
}

function parseHashConversationId() {
    const hash = window.location.hash.replace(/^#/, '').trim();
    if (!hash)
        return null;
    return hash;
}

async function createNewConversation() {
    try {
        const data = await createConversation();
        state.conversationView = 'active';
        state.pendingRemoveId = null;
        getActions().closeSidebarDrawer();
        selectConversation(data.id);
        await fetchConversations();
    }
    catch (err) {
        alert('新建会话失败：' + (err instanceof Error ? err.message : String(err)));
    }
}

function selectConversation(id: string | number) {
    if (String(state.currentConversationId) === String(id) && state.currentEventSource) {
        return;
    }
    state.currentConversationId = id;
    window.location.hash = '#' + id;
    getActions().renderConversationList();
    getActions().updateConversationHeaders();
    getActions().connectSse(id);
}

function setConversationView(view: string) {
    state.conversationView = view === 'archived' ? 'archived' : 'active';
    state.pendingRemoveId = null;
    getActions().renderConversationList();
}

function clearOpenConversation() {
    const es = state.currentEventSource;
    state.currentEventSource = null;
    if (es)
        es.close();
    state.currentConversationId = null;
    state.currentViewData = null;
    if (window.location.hash) {
        history.replaceState(null, '', window.location.pathname + window.location.search);
    }
    getActions().updateConversationHeaders();
    const chatEl = document.getElementById('messages-container')!;
    if (chatEl) {
        const container = document.createElement('div');
        getActions().renderEmptyConversation(container);
        getActions().patchChildren(chatEl, container);
    }
    getActions().renderNotes({ todos: [], memos: [] });
    getActions().renderReminders([]);
    getActions().renderTasks([]);
    getActions().updateBusyControls(false, 0);
    getActions().renderConversationList();
}

async function runShelf(id: string | number, action: string) {
    if (state.shelfBusy)
        return;
    state.shelfBusy = true;
    const wasCurrent = String(state.currentConversationId) === String(id);
    try {
        const result = await postShelf(id, action);
        state.pendingRemoveId = null;
        if (action === 'remove') {
            state.conversations = state.conversations.filter((c) => String(c.id) !== String(id));
        }
        else {
            const item = state.conversations.find((c) => String(c.id) === String(id));
            if (item)
                item.archivedAt = result.archivedAt ?? null;
        }
        if (action === 'restore' && wasCurrent)
            state.conversationView = 'active';
        getActions().renderConversationList();
        await fetchConversations();
        if (wasCurrent && action !== 'restore') {
            const next = state.conversations.find((c) => !c.archivedAt);
            if (next)
                selectConversation(next.id);
            else
                clearOpenConversation();
        }
    }
    catch (err) {
        showToast((err instanceof Error ? err.message : String(err)) || '操作失败', 'warning');
    }
    finally {
        state.shelfBusy = false;
    }
}

function handleConversationAction(id: string | number, action: string) {
    if (!id)
        return;
    if (action === 'open') {
        selectConversation(id);
        getActions().closeSidebarDrawer();
        return;
    }
    if (action === 'remove') {
        state.pendingRemoveId = String(id);
        getActions().renderConversationList();
        return;
    }
    if (action === 'cancel-remove') {
        state.pendingRemoveId = null;
        getActions().renderConversationList();
        return;
    }
    if (action === 'confirm-remove') {
        void runShelf(id, 'remove');
        return;
    }
    if (action === 'archive' || action === 'restore')
        void runShelf(id, action);
}

function onConversationListClick(e: MouseEvent) {
    const actionEl = (e.target as Element | null)?.closest<HTMLElement>('[data-action]');
    if (!actionEl || !(e.currentTarget as HTMLElement).contains(actionEl))
        return;
    const item = actionEl.closest<HTMLElement>('.conversation-item');
    if (!item)
        return;
    handleConversationAction(item.dataset.id!, actionEl.dataset.action!);
}

// 从某条消息分叉
async function forkConversation(entryId: string | number) {
    if (!state.currentConversationId || !entryId)
        return;
    try {
        const data = await forkFromEntry(state.currentConversationId, entryId);
        selectConversation(data.id);
        await fetchConversations();
    }
    catch (err) {
        alert('分叉失败：' + (err instanceof Error ? err.message : String(err)));
    }
}

function goBackToParentConversation(e: Event) {
    e.preventDefault();
    const parentId = (e.currentTarget as HTMLElement).getAttribute('data-parent-id');
    if (parentId) {
        selectConversation(parentId);
    }
}
return { fetchConversations, createNewConversation, parseHashConversationId, selectConversation, onConversationListClick, forkConversation, setConversationView, goBackToParentConversation };
}
