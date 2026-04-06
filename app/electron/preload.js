const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("electronAPI", {
  onUpdateStatus: (callback) => ipcRenderer.on("update-status", (_, status) => callback(status)),
  installUpdate: () => ipcRenderer.send("install-update"),
});
