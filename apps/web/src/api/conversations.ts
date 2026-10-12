import type { ConversationItem } from "@assistant/contracts";
export async function listConversations(): Promise<ConversationItem[]> {
        const res = await fetch('/api/conversations');
        if (!res.ok)
            throw new Error('拉取会话列表失败');
        return await res.json();

}
export async function createConversation(): Promise<{id: number}> {
        const res = await fetch('/api/conversations', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
        });
        if (!res.ok)
            throw new Error('新建会话失败');
        return await res.json();

}
export async function postShelf(id: string | number, action: string): Promise<{ id: number; archivedAt?: string | null; removed?: boolean }> {
    const res = await fetch(`/api/conversations/${encodeURIComponent(id)}/${action}`, { method: 'POST' });
    const body = await res.json().catch(() => ({}));
    if (!res.ok)
        throw new Error(body.error || '操作失败');
    return body;
}


export async function forkFromEntry(id: string | number, entryId: string | number): Promise<{id: number}> {
        const res = await fetch(`/api/conversations/${encodeURIComponent(id)}/fork`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ entryId }),
        });
        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new Error(err.error || '分叉会话失败');
        }
        return await res.json();

}
