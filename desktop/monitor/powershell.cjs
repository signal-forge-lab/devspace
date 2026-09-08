"use strict";

const { spawnSync } = require("node:child_process");

function resolvePowerShellExecutable(options = {}) {
  const spawnSyncImpl = options.spawnSync || spawnSync;
  const platform = options.platform || process.platform;
  const env = options.env || process.env;
  const candidates = platform === "win32"
    ? ["pwsh.exe", "powershell.exe"]
    : ["pwsh", "powershell"];

  for (const executable of candidates) {
    const probe = spawnSyncImpl(
      executable,
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "exit 0"],
      { env, stdio: "ignore", windowsHide: true },
    );
    if (!probe.error) return executable;
  }

  throw new Error("PowerShell was not found. Install PowerShell 7 (pwsh) or Windows PowerShell.");
}

function runPowerShell(args, options = {}) {
  const spawnSyncImpl = options.spawnSync || spawnSync;
  const executable = resolvePowerShellExecutable(options);
  const result = spawnSyncImpl(executable, args, {
    env: options.env || process.env,
    stdio: options.stdio || "inherit",
    windowsHide: true,
  });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

if (require.main === module) {
  try {
    process.exitCode = runPowerShell(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

module.exports = { resolvePowerShellExecutable, runPowerShell };
