"use strict";

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("workbridgeDesktop", {
  getStatus: () => ipcRenderer.invoke("workbridge-monitor:get-status"),
  runAction: (action) => ipcRenderer.invoke("workbridge-monitor:run-action", action),
  onStatus: (listener) => {
    if (typeof listener !== "function") return;
    ipcRenderer.on("workbridge-monitor:status", (_event, status) => listener(status));
  },
});
