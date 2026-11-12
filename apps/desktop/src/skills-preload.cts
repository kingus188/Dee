import electron = require("electron");
const { contextBridge, ipcRenderer } = electron;

contextBridge.exposeInMainWorld("desktopAgent", {
  platform: process.platform,
  snapshot: () => ipcRenderer.invoke("desktop:agent:snapshot"),
  selectAgent: (input: unknown) => ipcRenderer.invoke("desktop:agent:select-agent", input),
  newSession: () => ipcRenderer.invoke("desktop:agent:new-session"),
  answerApproval: (input: unknown) => ipcRenderer.invoke("desktop:agent:answer-approval", input),
  send: (input: unknown) => ipcRenderer.invoke("desktop:agent:send", input),
  peerSessions: (node?: string) => ipcRenderer.invoke("desktop:agent:peer-sessions", node),
  readPeerSession: (input: unknown) => ipcRenderer.invoke("desktop:agent:read-peer-session", input),
  sendPeer: (input: unknown) => ipcRenderer.invoke("desktop:agent:send-peer", input),
  peerStatus: (id: string) => ipcRenderer.invoke("desktop:agent:peer-status", id),
  chooseWorkspace: () => ipcRenderer.invoke("desktop:agent:choose-workspace"),
  approve: (id: string) => ipcRenderer.invoke("desktop:agent:approve", id),
  reject: (id: string) => ipcRenderer.invoke("desktop:agent:reject", id),
  abort: () => ipcRenderer.invoke("desktop:agent:abort"),
  openServer: (hash?: string) => ipcRenderer.invoke("desktop:agent:open-server", hash),
  openConnection: () => ipcRenderer.invoke("desktop:agent:open-connection"),
});

contextBridge.exposeInMainWorld("desktopServer", {
  platform: process.platform,
  connect: (url: string) => ipcRenderer.invoke("desktop:server-connect", url),
  openSettings: () => ipcRenderer.invoke("desktop:connection-open"),
  notificationStatus: () => ipcRenderer.invoke("desktop:notification-status"),
});

contextBridge.exposeInMainWorld("desktopConnection", {
  openSettings: () => ipcRenderer.invoke("desktop:connection-open"),
  retry: () => ipcRenderer.invoke("desktop:connection-retry"),
});

// Only the configured service's top frame may invoke these handlers; paths stay in the main process.
contextBridge.exposeInMainWorld("localSkills", {
  version: 1,
  list: () => ipcRenderer.invoke("desktop:skills-list"),
  read: (id: string) => ipcRenderer.invoke("desktop:skills-read", id),
  reveal: (id: string) => ipcRenderer.invoke("desktop:skills-reveal", id),
  addDirectory: () => ipcRenderer.invoke("desktop:skills-add-directory"),
  removeDirectory: (id: string) => ipcRenderer.invoke("desktop:skills-remove-directory", id),
  importSkill: () => ipcRenderer.invoke("desktop:skills-import"),
});
