import type { AppState, AppActions } from "../state.js";

export function createApiEvents(state: AppState, getActions: () => Pick<AppActions, "hideReconnectBanner" | "fetchServerInfo" | "showReconnectBanner" | "renderView">) {
// --- SSE 连接与数据渲染 ---
function connectSse(conversationId: string | number) {
    if (state.currentEventSource) {
        state.currentEventSource.close();
        state.currentEventSource = null;
    }
    const url = `/api/conversations/${encodeURIComponent(conversationId)}/events`;
    const es = new EventSource(url);
    state.currentEventSource = es;
    es.onopen = () => {
        getActions().hideReconnectBanner();
        getActions().fetchServerInfo();
    };
    es.onerror = () => {
        // 切换会话时旧连接被关掉，也会触发 error。那不是断线。
        if (state.currentEventSource !== es)
            return;
        getActions().showReconnectBanner();
    };
    es.addEventListener('view', (e) => {
        if (state.currentEventSource !== es) return;
        try {
            const data = JSON.parse(e.data);
            state.currentViewData = data;
            getActions().renderView(data);
        }
        catch (err) {
            console.error('解析 SSE view 数据失败:', err);
        }
    });
}
return { connectSse };
}
