import type { MessageRequest } from "@assistant/contracts";
export async function sendMessage(id: string | number, body: MessageRequest) {
        const res = await fetch(`/api/conversations/${encodeURIComponent(id)}/messages`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new Error(err.error || 'HTTP ' + res.status);
        }

}
export async function abortConversation(id: string | number) {
        const res = await fetch(`/api/conversations/${encodeURIComponent(id)}/abort`, {
            method: 'POST',
        });
        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new Error(err.error || '停止失败');
        }
}
