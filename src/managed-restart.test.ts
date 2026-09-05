import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseManagedRestartWorkerArgs,
  readManagedRestartState,
  resolveLocalMonitorUrl,
  resolveManagedRestartStatePath,
  runManagedRestartWorker,
  scheduleManagedRestart,
  type ManagedRestartWorkerRuntime,
} from "./managed-restart.js";

const root = await mkdtemp(join(tmpdir(), "workbridge-managed-restart-test-"));
try {
  const stateDir = join(root, "state");
  const supervisorDir = join(root, "supervisor");
  const stateFile = join(supervisorDir, "supervisor-state.json");
  await mkdir(stateDir, { recursive: true });
  await mkdir(supervisorDir, { recursive: true });
  await writeFile(stateFile, JSON.stringify({
    version: 3,
    controlToken: "test-control-token",
    startupConfig: {
      publicBaseUrl: "https://workbridge.example.test",
      allowedRoots: [join(root, "projects")],
      auxiliaryRoots: [join(root, "auxiliary")],
      worktreeRoot: join(root, "projects", ".workbridge", "worktrees"),
      stateDir,
      trustProxy: true,
    },
    startupConfigSources: {
      publicBaseUrl: "environment",
      allowedRoots: "config.json",
      auxiliaryRoots: "config.json",
      worktreeRoot: "config.json",
      stateDir: "config.json",
      trustProxy: "config.json"
    },
  }), "utf8");

  assert.equal(
    resolveManagedRestartStatePath({ APPDATA: "C:\\Users\\test\\AppData\\Roaming" }, "win32"),
    "C:\\Users\\test\\AppData\\Roaming\\@workbridge\\session-monitor-desktop\\supervisor-state.json",
  );
  assert.equal(
    resolveManagedRestartStatePath({ HOME: "/home/test" }, "linux"),
    "/home/test/.config/@workbridge/session-monitor-desktop/supervisor-state.json",
  );
  assert.equal(
    resolveManagedRestartStatePath({ HOME: "/Users/test" }, "darwin"),
    "/Users/test/Library/Application Support/@workbridge/session-monitor-desktop/supervisor-state.json",
  );
  assert.equal(
    resolveManagedRestartStatePath({ WORKBRIDGE_SUPERVISOR_STATE_FILE: stateFile }, "win32"),
    stateFile,
  );

  assert.equal(
    resolveLocalMonitorUrl({ WORKBRIDGE_MONITOR_PORT: "8765" }),
    "http://127.0.0.1:8765",
  );
  assert.throws(
    () => resolveLocalMonitorUrl({ WORKBRIDGE_MONITOR_URL: "https://example.com" }),
    /local HTTP|loopback/,
  );

  const state = await readManagedRestartState(stateFile);
  assert.equal(state.controlToken, "test-control-token");
  assert.equal(state.startupConfig.stateDir, stateDir);
  assert.deepEqual(state.startupConfig.allowedRoots, [join(root, "projects")]);
  assert.deepEqual(state.startupConfig.auxiliaryRoots, [join(root, "auxiliary")]);
  assert.equal(state.startupConfig.worktreeRoot, join(root, "projects", ".workbridge", "worktrees"));

  let helperInvocation: {
    command: string;
    args: string[];
    options: Record<string, unknown>;
  } | undefined;
  const scheduled = await scheduleManagedRestart({
    currentCliPath: join(root, "src", "cli.ts"),
    serverCliPath: join(root, "dist", "cli.js"),
    expectedVersion: "1.4.12",
    stateFile,
    monitorUrl: "http://127.0.0.1:8765",
  }, {
    spawnHelper: (command, args, options) => {
      helperInvocation = { command, args: [...args], options: { ...options } };
      return { pid: 321, unref: () => undefined };
    },
  });
  assert.equal(scheduled.pid, 321);
  assert.equal(scheduled.logFile, join(stateDir, "managed-restart.jsonl"));
  assert.ok(helperInvocation);
  assert.equal(helperInvocation.command, process.execPath);
  assert.deepEqual(helperInvocation.options, {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  assert.ok(helperInvocation.args.includes("__managed-restart-worker"));
  assert.ok(helperInvocation.args.includes("--import"));
  assert.ok(helperInvocation.args.includes("tsx"));
  assert.doesNotMatch(helperInvocation.args.join(" "), /test-control-token/);

  const parsed = parseManagedRestartWorkerArgs([
    "--state-file", stateFile,
    "--monitor-url", "http://127.0.0.1:8765",
    "--server-cli", join(root, "dist", "cli.js"),
    "--expected-version", "1.4.12",
  ]);
  assert.equal(parsed.stateFile, stateFile);
  assert.equal(parsed.expectedVersion, "1.4.12");

  const events: string[] = [];
  let monitorRelaunchRequestPath: string | undefined;
  let statusReads = 0;
  let shutdownToken: string | undefined;
  let spawnedEnvironment: NodeJS.ProcessEnv | undefined;
  const runtime: ManagedRestartWorkerRuntime = {
    requestShutdown: async (_url, token) => {
      shutdownToken = token;
      return true;
    },
    readVersion: async () => {
      statusReads += 1;
      return statusReads === 1
        ? undefined
        : "1.4.12";
    },
    spawnServer: (input) => {
      spawnedEnvironment = input.env;
      assert.equal(input.command, process.execPath);
      assert.deepEqual(input.args, [join(root, "dist", "cli.js"), "serve"]);
      assert.equal(input.cwd, root);
      return 654;
    },
    sleep: async () => undefined,
    appendLog: async (_path, event) => {
      events.push(event);
    },
    requestMonitorRelaunch: async (path) => {
      monitorRelaunchRequestPath = path;
    },
  };

  const inheritedStartupEnvironment = {
    DEVSPACE_ALLOWED_ROOTS: process.env.DEVSPACE_ALLOWED_ROOTS,
    WORKBRIDGE_AUXILIARY_ROOTS: process.env.WORKBRIDGE_AUXILIARY_ROOTS,
    DEVSPACE_WORKTREE_ROOT: process.env.DEVSPACE_WORKTREE_ROOT,
    DEVSPACE_STATE_DIR: process.env.DEVSPACE_STATE_DIR,
    DEVSPACE_TRUST_PROXY: process.env.DEVSPACE_TRUST_PROXY,
  };
  process.env.DEVSPACE_ALLOWED_ROOTS = "stale-inherited-roots";
  process.env.WORKBRIDGE_AUXILIARY_ROOTS = "stale-inherited-aux";
  process.env.DEVSPACE_WORKTREE_ROOT = "stale-inherited-worktrees";
  process.env.DEVSPACE_STATE_DIR = "stale-inherited-state";
  process.env.DEVSPACE_TRUST_PROXY = "1";

  try {
    await runManagedRestartWorker({
      stateFile,
      monitorUrl: "http://127.0.0.1:8765",
      serverCliPath: join(root, "dist", "cli.js"),
      expectedVersion: "1.4.12",
    }, runtime);
  } finally {
    for (const [key, value] of Object.entries(inheritedStartupEnvironment)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
  assert.equal(shutdownToken, "test-control-token");
  assert.equal(spawnedEnvironment?.WORKBRIDGE_MONITOR_CONTROL_TOKEN, "test-control-token");
  assert.equal(spawnedEnvironment?.WORKBRIDGE_MONITOR_PORT, "8765");
  assert.equal(spawnedEnvironment?.DEVSPACE_PUBLIC_BASE_URL, "https://workbridge.example.test");
  assert.equal(spawnedEnvironment?.DEVSPACE_ALLOWED_ROOTS, undefined);
  assert.equal(spawnedEnvironment?.WORKBRIDGE_AUXILIARY_ROOTS, undefined);
  assert.equal(spawnedEnvironment?.DEVSPACE_WORKTREE_ROOT, undefined);
  assert.equal(spawnedEnvironment?.DEVSPACE_STATE_DIR, undefined);
  assert.equal(spawnedEnvironment?.DEVSPACE_TRUST_PROXY, undefined);
  assert.equal(
    monitorRelaunchRequestPath,
    join(supervisorDir, "monitor-relaunch-request.json"),
  );
  assert.deepEqual(events, [
    "managed_restart_started",
    "managed_restart_shutdown_accepted",
    "managed_restart_server_spawned",
    "managed_restart_monitor_relaunch_requested",
    "managed_restart_completed",
  ]);
} finally {
  await rm(root, { recursive: true, force: true });
}

console.log("managed restart tests passed");
