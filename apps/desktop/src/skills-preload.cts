import electron = require("electron");
const { contextBridge, ipcRenderer } = electron;

contextBridge.exposeInMainWorld("desktopServer", {
  connect: (url: string) => ipcRenderer.invoke("desktop:server-connect", url),
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
