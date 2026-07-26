"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  SUPPORTED_ACTIONS,
  WorkbridgeSupervisor,
  controlShutdownUrl,
  isWorkbridgeRoot,
  npmInvocation,
  resolveWorkbridgeProjectRoot,
  runtimeStatusUrl,
} = require("./supervisor.cjs");

const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "workbridge-supervisor-test-"));
const projectRoot = path.join(temporaryRoot, "project");
fs.mkdirSync(path.join(projectRoot, "src"), { recursive: true });
fs.writeFileSync(
  path.join(projectRoot, "package.json"),
  JSON.stringify({ name: "@waishnav/devspace" }),
  "utf8",
);

assert.equal(isWorkbridgeRoot(projectRoot), true);
assert.equal(isWorkbridgeRoot(temporaryRoot), false);
assert.equal(resolveWorkbridgeProjectRoot(undefined, [path.join(projectRoot, "src")]), projectRoot);
assert.throws(
  () => resolveWorkbridgeProjectRoot(path.join(temporaryRoot, "missing"), []),
  /Unable to locate/,
);
assert.equal(
  runtimeStatusUrl("http://127.0.0.1:7676/monitor"),
  "http://127.0.0.1:7676/monitor/api/status",
);
assert.equal(
  controlShutdownUrl("http://127.0.0.1:7676/monitor"),
  "http://127.0.0.1:7676/monitor/api/control/shutdown",
);
assert.deepEqual(
  Array.from(SUPPORTED_ACTIONS).sort(),
  ["build", "build-restart", "pause", "restart", "resume", "start", "stop"],
);
const npmBuild = npmInvocation(["run", "build"]);
if (process.platform === "win32") {
  assert.match(npmBuild.command.toLowerCase(), /cmd\.exe$/);
  assert.deepEqual(npmBuild.args.slice(0, 3), ["/d", "/s", "/c"]);
  assert.equal(npmBuild.args[3], "npm run build");
} else {
  assert.deepEqual(npmBuild, { command: "npm", args: ["run", "build"] });
}

const supervisor = new WorkbridgeSupervisor({
  monitorUrl: "http://127.0.0.1:9/monitor",
  projectRoot,
  tokenFile: path.join(temporaryRoot, "token.json"),
});
assert.deepEqual(supervisor.status().capabilities, {
  start: true,
  stop: false,
  restart: false,
  build: true,
  buildRestart: true,
  pause: true,
  resume: true,
});
assert.equal(supervisor.status().state, "stopped");
assert.equal(supervisor.status().ownership, "none");

supervisor.serverReachable = true;
supervisor.runtimeStatus = {
  server: { controlEnabled: false, pid: 1234 },
};
assert.equal(supervisor.status().state, "running");
assert.equal(supervisor.status().ownership, "external");
assert.equal(supervisor.status().capabilities.build, true);
assert.equal(supervisor.status().capabilities.pause, true);
assert.equal(supervisor.status().capabilities.resume, true);
assert.equal(supervisor.status().capabilities.stop, false);
assert.equal(supervisor.status().capabilities.restart, false);
assert.equal(supervisor.status().capabilities.buildRestart, false);

fs.rmSync(temporaryRoot, { recursive: true, force: true });
console.log("desktop supervisor tests passed");
