"use strict";

const fs = require("node:fs");
const http = require("node:http");
const https = require("node:https");
const path = require("node:path");
const {
  app,
  BrowserWindow,
  Menu,
  nativeImage,
  screen,
} = require("electron");
const {
  MINIMUM_HEIGHT,
  MINIMUM_WIDTH,
  isAllowedMonitorNavigation,
  normalizeWindowState,
  resolveMonitorUrl,
  waitingPageHtml,
  windowStateIsVisible,
} = require("./lib.cjs");

let monitorUrl;
try {
  monitorUrl = resolveMonitorUrl(process.env.WORKBRIDGE_MONITOR_URL);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

const singleInstance = app.requestSingleInstanceLock();
if (!singleInstance) app.quit();

let mainWindow;
let retryTimer;
let waitingPageVisible = false;
let quitting = false;

app.on("second-instance", () => {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
});

app.on("web-contents-created", (_event, contents) => {
  contents.setWindowOpenHandler(() => ({ action: "deny" }));
  contents.on("will-attach-webview", (event) => event.preventDefault());
});

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  createMonitorWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createMonitorWindow();
  });
});

app.on("before-quit", () => {
  quitting = true;
  clearRetryTimer();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

function createMonitorWindow() {
  const persisted = loadWindowState();
  const visiblePersisted = persisted && windowStateIsVisible(
    persisted,
    screen.getAllDisplays(),
  ) ? persisted : undefined;
  const icon = createApplicationIcon();
  mainWindow = new BrowserWindow({
    width: visiblePersisted?.width ?? 1440,
    height: visiblePersisted?.height ?? 900,
    ...(visiblePersisted?.x !== undefined ? { x: visiblePersisted.x } : {}),
    ...(visiblePersisted?.y !== undefined ? { y: visiblePersisted.y } : {}),
    minWidth: MINIMUM_WIDTH,
    minHeight: MINIMUM_HEIGHT,
    title: "Workbridge Monitor",
    backgroundColor: "#0b1016",
    autoHideMenuBar: true,
    show: false,
    ...(icon.isEmpty() ? {} : { icon }),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      devTools: process.env.WORKBRIDGE_MONITOR_DEVTOOLS === "1",
    },
  });

  mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  const blockUnexpectedNavigation = (event, target) => {
    if (!isAllowedMonitorNavigation(target, monitorUrl)) event.preventDefault();
  };
  mainWindow.webContents.on("will-navigate", blockUnexpectedNavigation);
  mainWindow.webContents.on("will-redirect", blockUnexpectedNavigation);
  mainWindow.once("ready-to-show", () => {
    mainWindow?.show();
    if (visiblePersisted?.maximized) mainWindow?.maximize();
  });
  mainWindow.on("close", () => saveWindowState(mainWindow));
  mainWindow.on("closed", () => {
    clearRetryTimer();
    mainWindow = undefined;
  });

  void loadMonitorWhenReady();
}

async function loadMonitorWhenReady() {
  if (!mainWindow || mainWindow.isDestroyed() || quitting) return;
  clearRetryTimer();
  const available = await probeMonitor(monitorUrl);
  if (!mainWindow || mainWindow.isDestroyed() || quitting) return;
  if (available) {
    waitingPageVisible = false;
    try {
      await mainWindow.loadURL(monitorUrl);
      return;
    } catch {
      // The server can disappear between the probe and navigation. Retry below.
    }
  }
  if (!waitingPageVisible) {
    waitingPageVisible = true;
    const waitingIcon = createApplicationIcon();
    const html = waitingPageHtml(
      monitorUrl,
      "Workbridgeがまだ応答していません。サーバーを起動したままお待ちください。",
      waitingIcon.isEmpty() ? undefined : waitingIcon.toDataURL(),
    );
    await mainWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  }
  retryTimer = setTimeout(() => void loadMonitorWhenReady(), 1500);
  retryTimer.unref?.();
}

function probeMonitor(value) {
  return new Promise((resolve) => {
    const parsed = new URL(value);
    const client = parsed.protocol === "https:" ? https : http;
    const request = client.get(parsed, {
      headers: { accept: "text/html", "user-agent": "Workbridge-Monitor-Desktop" },
      timeout: 1200,
    }, (response) => {
      const ok = response.statusCode !== undefined
        && response.statusCode >= 200
        && response.statusCode < 400;
      response.resume();
      resolve(ok);
    });
    request.once("timeout", () => {
      request.destroy();
      resolve(false);
    });
    request.once("error", () => resolve(false));
  });
}

function clearRetryTimer() {
  if (!retryTimer) return;
  clearTimeout(retryTimer);
  retryTimer = undefined;
}

function stateFilePath() {
  return path.join(app.getPath("userData"), "window-state.json");
}

function loadWindowState() {
  try {
    return normalizeWindowState(JSON.parse(fs.readFileSync(stateFilePath(), "utf8")));
  } catch {
    return undefined;
  }
}

function saveWindowState(window) {
  if (!window || window.isDestroyed()) return;
  try {
    const bounds = window.isMaximized() ? window.getNormalBounds() : window.getBounds();
    fs.mkdirSync(path.dirname(stateFilePath()), { recursive: true });
    fs.writeFileSync(
      stateFilePath(),
      JSON.stringify({ ...bounds, maximized: window.isMaximized() }),
      "utf8",
    );
  } catch (error) {
    console.warn(`Unable to save Workbridge Monitor window state: ${String(error)}`);
  }
}

function createApplicationIcon() {
  return nativeImage.createFromPath(
    path.join(__dirname, "assets", "workbridge-monitor-icon.png"),
  );
}
