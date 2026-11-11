import electron = require("electron");
const { contextBridge, ipcRenderer } = electron;
contextBridge.exposeInMainWorld("desktopAgent", {
  snapshot: () => ipcRenderer.invoke("desktop:agent:snapshot"),
  saveModel: (input: unknown) => ipcRenderer.invoke("desktop:agent:save-model", input),
  send: (input: unknown) => ipcRenderer.invoke("desktop:agent:send", input),
  chooseWorkspace: () => ipcRenderer.invoke("desktop:agent:choose-workspace"),
  approve: (id: string) => ipcRenderer.invoke("desktop:agent:approve", id),
  reject: (id: string) => ipcRenderer.invoke("desktop:agent:reject", id),
  abort: () => ipcRenderer.invoke("desktop:agent:abort"),
  openServer: () => ipcRenderer.invoke("desktop:agent:open-server"),
  openConnection: () => ipcRenderer.invoke("desktop:agent:open-connection"),
});
