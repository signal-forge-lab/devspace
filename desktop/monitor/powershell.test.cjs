"use strict";

const assert = require("node:assert/strict");
const { resolvePowerShellExecutable, runPowerShell } = require("./powershell.cjs");

function unavailable() {
  const error = new Error("not found");
  error.code = "ENOENT";
  return { error, status: null };
}

assert.equal(resolvePowerShellExecutable({
  platform: "win32",
  spawnSync: (command) => command === "pwsh.exe" ? { status: 0 } : unavailable(),
}), "pwsh.exe");

assert.equal(resolvePowerShellExecutable({
  platform: "win32",
  spawnSync: (command) => command === "powershell.exe" ? { status: 0 } : unavailable(),
}), "powershell.exe");

const calls = [];
const status = runPowerShell(["-NoProfile", "-Command", "Write-Output ok"], {
  platform: "win32",
  stdio: "pipe",
  spawnSync: (command, args) => {
    calls.push({ command, args });
    if (args.includes("exit 0")) return command === "pwsh.exe" ? { status: 0 } : unavailable();
    return { status: 7 };
  },
});
assert.equal(status, 7);
assert.equal(calls.at(-1).command, "pwsh.exe");
assert.deepEqual(calls.at(-1).args, ["-NoProfile", "-Command", "Write-Output ok"]);

assert.throws(() => resolvePowerShellExecutable({
  platform: "win32",
  spawnSync: () => unavailable(),
}), /PowerShell was not found/);

console.log("PowerShell resolver tests passed");
