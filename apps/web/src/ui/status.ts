import { readServerInfo } from "../api/server.js";
import type { AppState, AppActions } from "../state.js";

export function createUiStatus(state: AppState, getActions: () => Pick<AppActions, "updateMascotState">) {
  function showReconnectBanner() {
    state.isDisconnected = true;
    document.getElementById("reconnect-banner")!.style.display = "flex";
    getActions().updateMascotState();
  }

  function hideReconnectBanner() {
    state.isDisconnected = false;
    document.getElementById("reconnect-banner")!.style.display = "none";
    getActions().updateMascotState();
  }

  async function fetchServerInfo() {
    try {
      const info = await readServerInfo();
      state.serverInfo = info;
      if (state.previousBoots !== null && info.boots > state.previousBoots) {
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
      getActions().updateMascotState();
    } catch (error) {
      console.warn("读取服务状态失败:", error);
    }
  }
  return { hideReconnectBanner, fetchServerInfo, showReconnectBanner };
}
