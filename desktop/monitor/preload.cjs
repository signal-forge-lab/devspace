"use strict";

const { contextBridge, ipcRenderer } = require("electron");

const monitorApi = {
  getStatus: () => ipcRenderer.invoke("workbridge-monitor:get-status"),
  runAction: (action) => ipcRenderer.invoke("workbridge-monitor:run-action", action),
  saveStartupConfig: (config) => ipcRenderer.invoke("workbridge-monitor:save-startup-config", config),
  onStatus: (listener) => {
    if (typeof listener !== "function") return;
    ipcRenderer.on("workbridge-monitor:status", (_event, status) => listener(status));
  },
};

contextBridge.exposeInMainWorld("workbridgeDesktop", monitorApi);
contextBridge.exposeInMainWorld("workbridgeMonitorHost", { kind: "electron", api: monitorApi });
