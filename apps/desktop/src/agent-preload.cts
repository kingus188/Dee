import electron = require("electron");
const { contextBridge, ipcRenderer } = electron;
contextBridge.exposeInMainWorld("desktopAgent", {
  platform: process.platform,
  snapshot: () => ipcRenderer.invoke("desktop:agent:snapshot"),
  saveModel: (input: unknown) => ipcRenderer.invoke("desktop:agent:save-model", input),
  selectAgent: (input: unknown) => ipcRenderer.invoke("desktop:agent:select-agent", input),
  newSession: () => ipcRenderer.invoke("desktop:agent:new-session"),
  answerApproval: (input: unknown) => ipcRenderer.invoke("desktop:agent:answer-approval", input),
  send: (input: unknown) => ipcRenderer.invoke("desktop:agent:send", input),
  chooseWorkspace: () => ipcRenderer.invoke("desktop:agent:choose-workspace"),
  approve: (id: string) => ipcRenderer.invoke("desktop:agent:approve", id),
  reject: (id: string) => ipcRenderer.invoke("desktop:agent:reject", id),
  abort: () => ipcRenderer.invoke("desktop:agent:abort"),
  openServer: (hash?: string) => ipcRenderer.invoke("desktop:agent:open-server", hash),
  openConnection: () => ipcRenderer.invoke("desktop:agent:open-connection"),
});
