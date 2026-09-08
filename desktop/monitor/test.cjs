"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  DEFAULT_MONITOR_URL,
  desktopMemorySnapshot,
  isAllowedMonitorNavigation,
  normalizeWindowState,
  resolveMonitorUrl,
  waitingPageHtml,
  windowStateIsVisible,
} = require("./lib.cjs");

const firstMemorySample = desktopMemorySnapshot([
  { pid: 10, type: "Browser", memory: { workingSetSize: 100, privateBytes: 80 } },
  { pid: 11, type: "Tab", memory: { workingSetSize: 200, privateBytes: 120 } },
  { pid: 12, type: "FutureType", memory: { workingSetSize: 50, privateBytes: 25 } },
], 32 * 1024 ** 3, 3 * 1024 ** 3, null, 1_000);
assert.equal(firstMemorySample.sampledAt, 1_000);
assert.equal(firstMemorySample.workingSetBytes, 350 * 1024);
assert.equal(firstMemorySample.privateBytes, 225 * 1024);
assert.equal(firstMemorySample.peakWorkingSetBytes, 350 * 1024);
assert.deepEqual(firstMemorySample.processes[2], {
  type: "FutureType",
  pid: 12,
  workingSetBytes: 50 * 1024,
  privateBytes: 25 * 1024,
});
assert.deepEqual(firstMemorySample.system, {
  totalBytes: 32 * 1024 ** 3,
  freeBytes: 3 * 1024 ** 3,
  usedBytes: 29 * 1024 ** 3,
});

const secondMemorySample = desktopMemorySnapshot([
  { type: "Browser", memory: { workingSetSize: 300, privateBytes: 150 } },
  { type: "Tab", memory: { workingSetSize: 100, privateBytes: 50 } },
], 32 * 1024 ** 3, 4 * 1024 ** 3, firstMemorySample.peakWorkingSetBytes, 2_000);
assert.equal(secondMemorySample.workingSetBytes, 400 * 1024);
assert.equal(secondMemorySample.peakWorkingSetBytes, 400 * 1024);

const thirdMemorySample = desktopMemorySnapshot([
  { type: "Browser", memory: { workingSetSize: 250 } },
], 32 * 1024 ** 3, 5 * 1024 ** 3, secondMemorySample.peakWorkingSetBytes, 3_000);
assert.equal(thirdMemorySample.workingSetBytes, 250 * 1024);
assert.equal(thirdMemorySample.peakWorkingSetBytes, 400 * 1024);

const partialMemorySample = desktopMemorySnapshot([
  { type: "Browser", memory: { workingSetSize: 100, privateBytes: 80 } },
  { type: "Utility", memory: { workingSetSize: 50 } },
], 1_000, 250, null, 3_500);
assert.equal(partialMemorySample.workingSetBytes, 150 * 1024);
assert.equal(partialMemorySample.privateBytes, null);

const unavailableMemorySample = desktopMemorySnapshot([
  { pid: "not-a-pid", type: "", memory: {} },
], undefined, undefined, null, 4_000);
assert.deepEqual(unavailableMemorySample.processes[0], {
  type: "Unknown",
  pid: null,
  workingSetBytes: null,
  privateBytes: null,
});
assert.equal(unavailableMemorySample.workingSetBytes, null);
assert.equal(unavailableMemorySample.privateBytes, null);
assert.equal(unavailableMemorySample.peakWorkingSetBytes, null);
assert.deepEqual(unavailableMemorySample.system, {
  totalBytes: null,
  freeBytes: null,
  usedBytes: null,
});

assert.equal(resolveMonitorUrl(), DEFAULT_MONITOR_URL);
assert.equal(resolveMonitorUrl("http://127.0.0.1:7677/"), DEFAULT_MONITOR_URL);
assert.equal(resolveMonitorUrl("http://localhost:7676/monitor/"), "http://localhost:7676/monitor");
assert.equal(resolveMonitorUrl("https://[::1]:7676/monitor/"), "https://[::1]:7676/monitor");
assert.throws(() => resolveMonitorUrl("https://monitor.example.test/monitor/"), /loopback hostname/);
assert.throws(() => resolveMonitorUrl("file:///tmp/monitor"), /http or https/);
assert.throws(() => resolveMonitorUrl("http://user:pass@127.0.0.1/monitor"), /credentials/);

assert.equal(
  isAllowedMonitorNavigation("http://127.0.0.1:7677/monitor", DEFAULT_MONITOR_URL),
  true,
);
assert.equal(
  isAllowedMonitorNavigation("http://127.0.0.1:7677/monitor/", DEFAULT_MONITOR_URL),
  true,
);
assert.equal(
  isAllowedMonitorNavigation("http://127.0.0.1:7677/other", DEFAULT_MONITOR_URL),
  false,
);
assert.equal(
  isAllowedMonitorNavigation("https://example.test/monitor", DEFAULT_MONITOR_URL),
  false,
);

assert.deepEqual(normalizeWindowState({ width: 400, height: 300, x: 10.4, y: 20.7 }), {
  width: 960,
  height: 640,
  x: 10,
  y: 21,
  maximized: false,
});
assert.equal(normalizeWindowState({ width: "wide", height: 800 }), undefined);
assert.equal(windowStateIsVisible(
  { width: 1000, height: 700, x: 50, y: 50 },
  [{ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }],
), true);
assert.equal(windowStateIsVisible(
  { width: 1000, height: 700, x: 5000, y: 5000 },
  [{ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }],
), false);

const waiting = waitingPageHtml("http://127.0.0.1:7677/monitor?<unsafe>", "<waiting>");
assert.match(waiting, /Workbridge Monitor/);
assert.doesNotMatch(waiting, /<unsafe>/);
assert.doesNotMatch(waiting, /<waiting>/);
const waitingWithIcon = waitingPageHtml(
  "http://127.0.0.1:7677/monitor",
  "waiting",
  "data:image/png;base64,aGVsbG8=",
);
assert.match(waitingWithIcon, /class="brand-icon"/);
assert.match(waitingWithIcon, /field input:not\(\[type="checkbox"\]\)/);
assert.match(waitingWithIcon, /proxy input\{width:auto;flex:0 0 auto;margin:0/);
assert.match(waitingWithIcon, /Startup Config/);
assert.match(waitingWithIcon, /id="public-url"/);
assert.match(waitingWithIcon, /Project Roots/);
assert.match(waitingWithIcon, /id="auxiliary-roots"/);
assert.match(waitingWithIcon, /id="worktree-root"/);
assert.match(waitingWithIcon, /saveStartupConfig/);
assert.doesNotMatch(waitingWithIcon, /data-action="resume"/);
assert.match(waitingWithIcon, /const stateLabels=/);
assert.match(waitingWithIcon, /starting:'起動中'/);
assert.match(waitingWithIcon, /id="state-label">状態確認中/);
assert.match(waitingWithIcon, /status\.state==='starting'&&!Number\.isInteger\(status\.managedPid\)\?'stopped'/);
assert.match(waitingWithIcon, /status\.operation\?\.startedAt/);
assert.match(waitingWithIcon, /経過 /);

const rootPackage = require(path.join(__dirname, "..", "..", "package.json"));
const monitorPackage = require(path.join(__dirname, "package.json"));
const publishedDesktopFiles = rootPackage.files.filter((value) =>
  value.startsWith("desktop/monitor"),
);
assert.deepEqual(publishedDesktopFiles, [
  "desktop/monitor/lib.cjs",
  "desktop/monitor/main.cjs",
  "desktop/monitor/preload.cjs",
  "desktop/monitor/install-windows.ps1",
  "desktop/monitor/package.json",
  "desktop/monitor/package-lock.json",
  "desktop/monitor/memory-log.cjs",
  "desktop/monitor/memory-log.test.cjs",
  "desktop/monitor/powershell.cjs",
  "desktop/monitor/powershell.test.cjs",
  "desktop/monitor/supervisor.cjs",
  "desktop/monitor/supervisor.test.cjs",
  "desktop/monitor/test.cjs",
  "desktop/monitor/assets/workbridge-monitor-icon.png",
  "desktop/monitor/assets/workbridge-monitor-icon.ico",
]);
assert.equal(publishedDesktopFiles.includes("desktop/monitor"), false);
assert.match(monitorPackage.scripts["pack:win"], /--icon=.*workbridge-monitor-icon\.ico/);
assert.equal(fs.existsSync(path.join(__dirname, "assets", "workbridge-monitor-icon.ico")), true);
assert.equal(rootPackage.scripts["monitor:launch"], "pnpm monitor:tauri:launch");
assert.equal(rootPackage.scripts["monitor:desktop:setup"], "npm run setup:win --prefix desktop/monitor");
assert.equal(
  monitorPackage.scripts["setup:win"],
  "npm run pack:win && node ./powershell.cjs -NoProfile -ExecutionPolicy Bypass -File ./install-windows.ps1",
);

const windowsInstallerSource = fs.readFileSync(path.join(__dirname, "install-windows.ps1"), "utf8");
assert.match(windowsInstallerSource, /Workbridge Monitor-win32-x64/);
assert.match(windowsInstallerSource, /Workbridge Monitor\.exe/);
assert.match(windowsInstallerSource, /CreateShortcut/);
assert.match(windowsInstallerSource, /GetFolderPath\("Desktop"\)/);
assert.match(windowsInstallerSource, /GetFolderPath\("StartMenu"\)/);
assert.match(windowsInstallerSource, /WorkingDirectory/);
assert.doesNotMatch(windowsInstallerSource, /electron\.exe/);

const preloadSource = fs.readFileSync(path.join(__dirname, "preload.cjs"), "utf8");
assert.match(preloadSource, /workbridgeMonitorHost/);
assert.match(preloadSource, /kind: "electron"/);
const mainSource = fs.readFileSync(path.join(__dirname, "main.cjs"), "utf8");
assert.match(mainSource, /app\.getAppMetrics\(\)/);
assert.match(mainSource, /desktopMemoryProvider/);
assert.match(mainSource, /memoryLogRuntime/);
assert.match(mainSource, /const status = await supervisor\.runAction\(action\);/);
assert.match(mainSource, /action === "restart" \|\| action === "build-restart"/);
assert.match(mainSource, /monitor-relaunch-requested/);
assert.match(mainSource, /function packagedMonitorExecutable\(\)/);
assert.match(mainSource, /app\.isPackaged/);
assert.match(mainSource, /Workbridge Monitor-win32-x64/);
assert.match(mainSource, /execPath: packagedExecutable/);
assert.match(mainSource, /app\.quit\(\);/);
assert.match(mainSource, /clearMonitorRelaunchTimer\(\);/);
assert.match(mainSource, /const window = mainWindow;/);
assert.match(mainSource, /monitorWindowIsUsable\(window\)/);
assert.match(mainSource, /await window\.loadURL\(monitorUrl\);/);
assert.match(mainSource, /window === mainWindow/);
assert.match(mainSource, /!window\.webContents\.isDestroyed\(\)/);
const supervisorSource = fs.readFileSync(path.join(__dirname, "supervisor.cjs"), "utf8");
assert.match(supervisorSource, /ensureManagedProcessExit\(managedChild\)/);
assert.match(supervisorSource, /child\.kill\(signal\)/);
assert.match(supervisorSource, /await this\.ensureSecureTunnel\(\);/);
assert.match(supervisorSource, /Workbridge started, but Secure Tunnel auto-start failed/);
assert.doesNotMatch(supervisorSource, /ensureManagedProcessExit\(managedPid\)/);
assert.doesNotMatch(supervisorSource, /process\.kill\(pid, signal\)/);
assert.ok(supervisorSource.indexOf("this.managedChild = child;") < supervisorSource.indexOf("this.setPhase(\"starting\", \"Starting Workbridge…\");"));

console.log("desktop monitor tests passed");
