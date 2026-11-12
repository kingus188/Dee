import electron = require("electron");
const { contextBridge, ipcRenderer } = electron;

contextBridge.exposeInMainWorld("desktopConnection", {
  load: () => ipcRenderer.invoke("desktop:connection-load"),
  save: (config: { url: string; lanUrl?: string; username?: string; password?: string }) => ipcRenderer.invoke("desktop:connection-save", config),
  retry: () => ipcRenderer.invoke("desktop:connection-retry"),
  openSettings: () => ipcRenderer.invoke("desktop:connection-open"),
});
