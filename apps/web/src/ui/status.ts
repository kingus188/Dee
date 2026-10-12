import { readServerInfo } from "../api/server.js";
import type { ServerInfo } from "../types.js";
import { formatTime } from "./format.js";
import type { AppState, AppActions } from "../state.js";

export function createUiStatus(state: AppState, getActions: () => Pick<AppActions, "updateMascotState">) {
// --- 断线重连横条控制 ---
const reconnectBanner = document.getElementById('reconnect-banner')!;

function showReconnectBanner() {
    state.isDisconnected = true;
    reconnectBanner.style.display = 'flex';
    getActions().updateMascotState();
}

function hideReconnectBanner() {
    state.isDisconnected = false;
    reconnectBanner.style.display = 'none';
    getActions().updateMascotState();
}

// --- API 调用 ---
async function fetchServerInfo() {
    try {
        const data = await readServerInfo();
        updateServerInfo(data);
    }
    catch (err) {
        console.warn('拉取 /api/info 失败:', err);
    }
}

function updateServerInfo(info: ServerInfo) {
    state.serverInfo = info;
    const pidEl = document.getElementById('stat-pid')!;
    const timeEl = document.getElementById('stat-started-at')!;
    const bootsEl = document.getElementById('stat-boots')!;
    const modelEl = document.getElementById('stat-model')!;
    if (pidEl)
        pidEl.textContent = String(info.pid || '-');
    if (timeEl)
        timeEl.textContent = formatTime(info.startedAt);
    if (modelEl)
        modelEl.textContent = info.model || info.api || '-';
    if (bootsEl && info.boots !== undefined) {
        bootsEl.textContent = `第 ${info.boots} 次启动`;
        // 若启动次数变大，说明经历过重启恢复
        if (state.previousBoots !== null && info.boots > state.previousBoots) {
            bootsEl.classList.remove('boots-updated');
            void bootsEl.offsetWidth; // 触发 reflow
            bootsEl.classList.add('boots-updated');
            // 触发小 D “刚恢复”状态（持续 4 秒）
            state.isRecovered = true;
            state.recoveredUntil = Date.now() + 4000;
            setTimeout(() => {
                if (Date.now() >= state.recoveredUntil) {
                    state.isRecovered = false;
                    getActions().updateMascotState();
                }
            }, 4050);
        }
        state.previousBoots = info.boots;
    }
    getActions().updateMascotState();
}
return { hideReconnectBanner, fetchServerInfo, showReconnectBanner };
}
