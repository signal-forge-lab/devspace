"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const {
  DEFAULT_MONITOR_URL,
  isAllowedMonitorNavigation,
  normalizeWindowState,
  resolveMonitorUrl,
  waitingPageHtml,
  windowStateIsVisible,
} = require("./lib.cjs");

assert.equal(resolveMonitorUrl(), DEFAULT_MONITOR_URL);
assert.equal(resolveMonitorUrl("http://127.0.0.1:7676/"), DEFAULT_MONITOR_URL);
assert.equal(resolveMonitorUrl("https://monitor.example.test/monitor/"), "https://monitor.example.test/monitor");
assert.throws(() => resolveMonitorUrl("file:///tmp/monitor"), /http or https/);
assert.throws(() => resolveMonitorUrl("http://user:pass@127.0.0.1/monitor"), /credentials/);

assert.equal(
  isAllowedMonitorNavigation("http://127.0.0.1:7676/monitor", DEFAULT_MONITOR_URL),
  true,
);
assert.equal(
  isAllowedMonitorNavigation("http://127.0.0.1:7676/monitor/", DEFAULT_MONITOR_URL),
  true,
);
assert.equal(
  isAllowedMonitorNavigation("http://127.0.0.1:7676/other", DEFAULT_MONITOR_URL),
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

const waiting = waitingPageHtml("http://127.0.0.1:7676/monitor?<unsafe>", "<waiting>");
assert.match(waiting, /Workbridge Monitor/);
assert.doesNotMatch(waiting, /<unsafe>/);
assert.doesNotMatch(waiting, /<waiting>/);
const waitingWithIcon = waitingPageHtml(
  "http://127.0.0.1:7676/monitor",
  "waiting",
  "data:image/png;base64,aGVsbG8=",
);
assert.match(waitingWithIcon, /class="brand-icon"/);

const rootPackage = require(path.join(__dirname, "..", "..", "package.json"));
const publishedDesktopFiles = rootPackage.files.filter((value) =>
  value.startsWith("desktop/monitor"),
);
assert.deepEqual(publishedDesktopFiles, [
  "desktop/monitor/lib.cjs",
  "desktop/monitor/main.cjs",
  "desktop/monitor/preload.cjs",
  "desktop/monitor/package.json",
  "desktop/monitor/package-lock.json",
  "desktop/monitor/supervisor.cjs",
  "desktop/monitor/supervisor.test.cjs",
  "desktop/monitor/test.cjs",
  "desktop/monitor/assets/workbridge-monitor-icon.png",
]);
assert.equal(publishedDesktopFiles.includes("desktop/monitor"), false);

console.log("desktop monitor tests passed");
