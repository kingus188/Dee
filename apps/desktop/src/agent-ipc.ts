import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from "electron";
import { dialog } from "electron";
import { openAgentSettings, validateAgentSelection } from "./agent-settings.js";
import { readAgentModels } from "./agents/models.js";
import { readAgentPermissions } from "./agents/permissions.js";
import { openDesktopAgent } from "./local-agent.js";
import type { AgentRequest } from "./local-agent.js";
import { isAppUrl, validateServerRoute } from "./policy.js";

export async function registerDesktopAgent(options: { ipc: IpcMain; directory: string; getWindow(): BrowserWindow | undefined; getOrigin(): string; localUrl: string; request: AgentRequest; serverId?: () => string; searchPath?: string; env?: NodeJS.ProcessEnv; openServer(hash?: string): Promise<void>; openConnection(): void }) {
  const settings = openAgentSettings(options.directory);
  const agent = await openDesktopAgent({ directory: options.directory, settings, request: options.request, serverId: options.serverId, searchPath: options.searchPath, env: options.env, confirm: async (tool, args) => {
    const window = options.getWindow();
    if (!window || window.isDestroyed()) return false;
    const response = await dialog.showMessageBox(window, { type: "question", title: "允许本机操作", message: `小 D 请求执行 ${tool}`, detail: JSON.stringify(args, null, 2).slice(0, 10000), buttons: ["拒绝", "允许本次"], defaultId: 0, cancelId: 0, noLink: true });
    return response.response === 1;
  } });
  function trusted(event: IpcMainInvokeEvent) {
    const window = options.getWindow();
    if (!window || window.isDestroyed() || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) throw new Error("Untrusted local Agent window");
    const url = event.senderFrame.url.split("#")[0] ?? "";
    if (url !== options.localUrl && !isAppUrl(url, options.getOrigin())) throw new Error("Untrusted local Agent window");
  }
  const handlers: Record<string, (input: never) => unknown> = {
    permissions: () => { const current = settings.get(); if (current.agent !== "codex" && current.agent !== "claude") return []; return readAgentPermissions(current.agent, current.agents[current.agent], options.searchPath, options.env); },
    models: () => { const current = settings.get(); if (current.agent === "pi" || !current.workspace) throw new Error("请选择外部 Agent"); return readAgentModels(current.agent, current.agents[current.agent], current.workspace, options.searchPath, options.env); },
    snapshot: () => agent.snapshot(), "select-agent": async input => {
      const selection = validateAgentSelection(input);
      const keys = ["permissionMode", "sandbox", "approvalPolicy"] as const;
      if (selection.config && keys.some(key => selection.config?.[key] !== undefined)) {
        const parameters = await readAgentPermissions(selection.kind, selection.config, options.searchPath, options.env);
        for (const key of keys) if (selection.config[key] !== undefined && !parameters.find(item => item.parameter === key)?.values.includes(selection.config[key]!)) throw new Error("Agent 不支持该权限参数");
      }
      return agent.selectAgent(selection);
    }, "new-session": () => agent.newSession(), "answer-approval": input => agent.answerApproval(input), send: input => agent.send(input), approve: input => agent.approve(input), reject: input => agent.reject(input), abort: () => agent.abort(),
    "peer-sessions": input => agent.sessions(input), "read-peer-session": input => agent.readSession(input), "send-peer": input => agent.sendPeer(input), "peer-status": input => agent.peerStatus(input),
    "choose-workspace": async () => {
      const window = options.getWindow(); if (!window) throw new Error("桌面窗口已关闭");
      const selected = await dialog.showOpenDialog(window, { title: "选择小 D 的工作目录", properties: ["openDirectory"] });
      if (!selected.canceled && selected.filePaths[0]) await agent.chooseWorkspace(selected.filePaths[0]);
    },
    "open-server": input => options.openServer(validateServerRoute(input)), "open-connection": () => options.openConnection(),
  };
  for (const [name, handler] of Object.entries(handlers)) options.ipc.handle(`desktop:agent:${name}`, async (event, input) => {
    trusted(event);
    try { return await handler(input as never); }
    catch (cause) {
      const message = cause instanceof Error ? cause.message : "本机操作失败";
      throw new Error(message);
    }
  });
  return agent;
}
