import { simulateCrash } from "../api/server.js";
import type { AppActions } from "../state.js";

export function createUiShell(getActions: () => Pick<AppActions, "showReconnectBanner">) {
// --- 模拟崩溃二次确认 ---
const crashModal = document.getElementById('crash-modal')!;

function openCrashModal() {
    crashModal.style.display = 'flex';
}

function closeCrashModal() {
    crashModal.style.display = 'none';
}

function onModalBackdropClick(e: Event) {
    if (e.target === crashModal) {
        closeCrashModal();
    }
}

async function confirmCrash() {
    closeCrashModal();
    getActions().showReconnectBanner();
    try {
        const res = await simulateCrash();
        if (!res.ok) {
            console.warn('POST /api/crash 返回非 200');
        }
    }
    catch (err) {
        console.log('模拟崩溃已触发，服务断开连接');
    }
}

// --- 移动端抽屉控制 ---
function openSidebarDrawer() {
    document.getElementById('sidebar-left')!.classList.add('open');
    document.getElementById('drawer-backdrop')!.classList.add('open');
}

function closeSidebarDrawer() {
    document.getElementById('sidebar-left')!.classList.remove('open');
    document.getElementById('drawer-backdrop')!.classList.remove('open');
}
return { closeSidebarDrawer, crashModal, closeCrashModal, openCrashModal, confirmCrash, onModalBackdropClick, openSidebarDrawer };
}
