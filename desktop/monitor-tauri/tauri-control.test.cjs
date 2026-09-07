"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const { parseInvocation, startupConfigFromDevspace, supervisorStateFile } = require("./tauri-control.cjs");

assert.deepEqual(parseInvocation(["node", "helper", "start"]), { kind: "action", action: "start" });
assert.deepEqual(parseInvocation(["node", "helper", "build-restart"]), { kind: "action", action: "build-restart" });
assert.deepEqual(parseInvocation(["node", "helper", "save-config"]), { kind: "save-config" });
assert.throws(() => parseInvocation(["node", "helper", "shell"]), /Unsupported/);
assert.equal(
  supervisorStateFile({ APPDATA: "C:\\Users\\test\\AppData\\Roaming" }),
  path.join("C:\\Users\\test\\AppData\\Roaming", "@workbridge", "session-monitor-desktop", "supervisor-state.json"),
);
assert.throws(() => supervisorStateFile({}), /APPDATA/);
assert.deepEqual(startupConfigFromDevspace({
  server: { publicBaseUrl: "https://example.test", trustProxy: true },
  workspaces: {
    allowedRoots: ["~/projects"],
    auxiliaryRoots: ["~/.codex", "~/.agents"],
    worktreeRoot: "~/projects/.workbridge/worktrees",
  },
  storage: { stateDir: "~/.workbridge-state" },
}), {
  publicBaseUrl: "https://example.test",
  allowedRoots: ["~/projects"],
  auxiliaryRoots: ["~/.codex", "~/.agents"],
  worktreeRoot: "~/projects/.workbridge/worktrees",
  stateDir: "~/.workbridge-state",
  trustProxy: true,
});

console.log("tauri control helper tests passed");
