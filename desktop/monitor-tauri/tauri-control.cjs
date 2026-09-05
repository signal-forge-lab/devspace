"use strict";

const path = require("node:path");
const {
  SUPPORTED_ACTIONS,
  WorkbridgeSupervisor,
  resolveWorkbridgeProjectRoot,
} = require("../monitor/supervisor.cjs");

function supervisorStateFile(environment = process.env) {
  const appData = environment.APPDATA?.trim();
  if (!appData) throw new Error("APPDATA is required for Workbridge Monitor control state.");
  return path.join(appData, "@workbridge", "session-monitor-desktop", "supervisor-state.json");
}

function parseInvocation(argv) {
  const action = argv[2];
  if (action === "save-config") return { kind: "save-config" };
  if (SUPPORTED_ACTIONS.has(action)) return { kind: "action", action };
  throw new Error("Unsupported Workbridge monitor action.");
}

async function readStdin(stream = process.stdin) {
  let body = "";
  stream.setEncoding("utf8");
  for await (const chunk of stream) body += chunk;
  if (!body.trim()) throw new Error("Startup Config payload is required.");
  return JSON.parse(body);
}

async function run(argv = process.argv, environment = process.env) {
  const invocation = parseInvocation(argv);
  const monitorUrl = environment.WORKBRIDGE_MONITOR_URL?.trim() || "http://127.0.0.1:7677/monitor";
  const projectRoot = resolveWorkbridgeProjectRoot(
    environment.WORKBRIDGE_PROJECT_ROOT,
    [process.cwd(), __dirname],
  );
  const supervisor = new WorkbridgeSupervisor({
    monitorUrl,
    projectRoot,
    tokenFile: supervisorStateFile(environment),
  });

  let status;
  try {
    if (invocation.kind === "save-config") {
      status = supervisor.setStartupConfig(await readStdin());
    } else {
      status = await supervisor.runAction(invocation.action);
    }
  } catch (error) {
    if (supervisor.managedChild) {
      try { await supervisor.ensureManagedProcessExit(supervisor.managedChild); }
      catch { /* preserve the original operation failure */ }
    }
    throw error;
  } finally {
    supervisor.stopPolling();
  }

  process.stdout.write(`${JSON.stringify({
    ok: true,
    managedPid: Number.isInteger(status?.managedPid) ? status.managedPid : null,
  })}\n`);
}

if (require.main === module) {
  run().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}

module.exports = { parseInvocation, supervisorStateFile };
