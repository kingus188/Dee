import electron = require("electron");
const { contextBridge, ipcRenderer } = electron;
contextBridge.exposeInMainWorld("desktopAgent", {
  platform: process.platform,
  snapshot: () => ipcRenderer.invoke("desktop:agent:snapshot"),
  agentModels: () => ipcRenderer.invoke("desktop:agent:models"),
  agentPermissions: () => ipcRenderer.invoke("desktop:agent:permissions"),
  selectAgent: (input: unknown) => ipcRenderer.invoke("desktop:agent:select-agent", input),
  setConversationSync: (input: unknown) => ipcRenderer.invoke("desktop:agent:set-conversation-sync", input),
  newSession: () => ipcRenderer.invoke("desktop:agent:new-session"),
  answerApproval: (input: unknown) => ipcRenderer.invoke("desktop:agent:answer-approval", input),
  send: (input: unknown) => ipcRenderer.invoke("desktop:agent:send", input),
  peerSessions: (node?: string) => ipcRenderer.invoke("desktop:agent:peer-sessions", node),
  readPeerSession: (input: unknown) => ipcRenderer.invoke("desktop:agent:read-peer-session", input),
  cancelPeer: (id: string) => ipcRenderer.invoke("desktop:agent:cancel-peer", id),
  sendPeer: (input: unknown) => ipcRenderer.invoke("desktop:agent:send-peer", input),
  peerStatus: (id: string) => ipcRenderer.invoke("desktop:agent:peer-status", id),
  chooseWorkspace: () => ipcRenderer.invoke("desktop:agent:choose-workspace"),
  approve: (id: string) => ipcRenderer.invoke("desktop:agent:approve", id),
  reject: (id: string) => ipcRenderer.invoke("desktop:agent:reject", id),
  abort: () => ipcRenderer.invoke("desktop:agent:abort"),
  openServer: (hash?: string) => ipcRenderer.invoke("desktop:agent:open-server", hash),
  openConnection: () => ipcRenderer.invoke("desktop:agent:open-connection"),
});
