"use strict";

const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { PassThrough } = require("node:stream");
const {
  DEFAULT_STARTUP_TIMEOUT_MS,
  SUPPORTED_ACTIONS,
  WorkbridgeSupervisor,
  controlShutdownUrl,
  isWorkbridgeRoot,
  npmInvocation,
  normalizeStartupConfig,
  resolveWorkbridgeProjectRoot,
  runtimeStatusUrl,
  startupConfigEnvironment,
  waitForProcessExit,
  waitForServerStartup,
} = require("./supervisor.cjs");

for (const key of [
  "DEVSPACE_PUBLIC_BASE_URL",
  "DEVSPACE_ALLOWED_ROOTS",
  "WORKBRIDGE_AUXILIARY_ROOTS",
  "DEVSPACE_WORKTREE_ROOT",
  "DEVSPACE_STATE_DIR",
  "DEVSPACE_TRUST_PROXY",
]) {
  delete process.env[key];
}

const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "workbridge-supervisor-test-"));
const projectRoot = path.join(temporaryRoot, "project");
process.env.DEVSPACE_CONFIG_DIR = path.join(temporaryRoot, "default-config");
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
assert.equal(DEFAULT_STARTUP_TIMEOUT_MS, 45_000);
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
assert.equal(supervisor.startupTimeoutMs, DEFAULT_STARTUP_TIMEOUT_MS);
assert.deepEqual(supervisor.status().capabilities, {
  start: false,
  stop: false,
  restart: false,
  build: true,
  buildRestart: false,
  pause: true,
  resume: false,
});
assert.equal(supervisor.status().state, "stopped");
assert.equal(supervisor.status().ownership, "none");
assert.equal(supervisor.status().startupConfigComplete, false);

const relaunchRequestFile = path.join(temporaryRoot, "monitor-relaunch-request.json");
let relaunchRequests = 0;
supervisor.on("monitor-relaunch-requested", () => { relaunchRequests += 1; });
fs.writeFileSync(relaunchRequestFile, "{}", "utf8");
supervisor.consumeMonitorRelaunchRequest();
assert.equal(relaunchRequests, 1);
assert.equal(fs.existsSync(relaunchRequestFile), false);

const legacyStateFile = path.join(temporaryRoot, "legacy-state.json");
fs.writeFileSync(legacyStateFile, JSON.stringify({
  version: 2,
  controlToken: "legacy-token",
  stateDir: "C:\\legacy-workbridge-state",
}), "utf8");
const legacySupervisor = new WorkbridgeSupervisor({
  monitorUrl: "http://127.0.0.1:9/monitor",
  projectRoot,
  tokenFile: legacyStateFile,
});
assert.equal(legacySupervisor.controlToken, "legacy-token");
assert.deepEqual(legacySupervisor.startupConfig, {});
assert.equal(legacySupervisor.status().startupConfigComplete, false);

assert.deepEqual(
  normalizeStartupConfig({
    publicBaseUrl: "https://monitor.example.test/",
    allowedRoots: "C:\\one,C:\\two",
    auxiliaryRoots: "C:\\aux-one,C:\\aux-two",
    worktreeRoot: "C:\\one\\.workbridge\\worktrees",
    stateDir: "C:\\custom-workbridge-state",
    trustProxy: "1",
    ignoredSecret: "must-not-persist",
  }, { requireComplete: true }),
  {
    publicBaseUrl: "https://monitor.example.test",
    allowedRoots: ["C:\\one", "C:\\two"],
    auxiliaryRoots: ["C:\\aux-one", "C:\\aux-two"],
    worktreeRoot: "C:\\one\\.workbridge\\worktrees",
    stateDir: "C:\\custom-workbridge-state",
    trustProxy: true,
  },
);
assert.throws(
  () => normalizeStartupConfig({ publicBaseUrl: "file:///tmp/workbridge" }, { requireComplete: true }),
  /http or https/,
);

const canonicalConfigFile = path.join(temporaryRoot, "config-source", "config.json");
fs.mkdirSync(path.dirname(canonicalConfigFile), { recursive: true });
fs.writeFileSync(canonicalConfigFile, JSON.stringify({
  host: "127.0.0.1",
  port: 7676,
  publicBaseUrl: "https://config.example.test",
  allowedRoots: ["C:\\config-workspace"],
  auxiliaryRoots: ["C:\\config-aux"],
  worktreeRoot: "C:\\config-workspace\\.workbridge\\worktrees",
  stateDir: "C:\\config-state",
  trustProxy: true,
}), "utf8");
const configSourceSupervisor = new WorkbridgeSupervisor({
  monitorUrl: "http://127.0.0.1:9/monitor",
  projectRoot,
  tokenFile: path.join(temporaryRoot, "config-source-state.json"),
  configFile: canonicalConfigFile,
  environment: {
    DEVSPACE_PUBLIC_BASE_URL: "https://override.example.test",
  },
});
assert.deepEqual(configSourceSupervisor.status().configuredStartupConfig, {
  publicBaseUrl: "https://config.example.test",
  allowedRoots: ["C:\\config-workspace"],
  auxiliaryRoots: ["C:\\config-aux"],
  worktreeRoot: "C:\\config-workspace\\.workbridge\\worktrees",
  stateDir: "C:\\config-state",
  trustProxy: true,
});
assert.equal(configSourceSupervisor.startupConfig.publicBaseUrl, "https://override.example.test");
assert.equal(configSourceSupervisor.status().startupConfigSources.publicBaseUrl, "environment");
assert.equal(configSourceSupervisor.status().startupConfigSources.allowedRoots, "config.json");
configSourceSupervisor.setStartupConfig({
  publicBaseUrl: "https://saved.example.test",
  allowedRoots: ["C:\\saved-workspace"],
  auxiliaryRoots: [],
  worktreeRoot: "C:\\saved-workspace\\.workbridge\\worktrees",
  stateDir: "C:\\saved-state",
  trustProxy: false,
});
const savedCanonicalConfig = JSON.parse(fs.readFileSync(canonicalConfigFile, "utf8"));
assert.equal(savedCanonicalConfig.host, "127.0.0.1");
assert.equal(savedCanonicalConfig.port, 7676);
assert.equal(savedCanonicalConfig.publicBaseUrl, "https://saved.example.test");
assert.equal(savedCanonicalConfig.trustProxy, false);
assert.equal(configSourceSupervisor.startupConfig.publicBaseUrl, "https://override.example.test");
assert.equal(configSourceSupervisor.commandEnvironment().DEVSPACE_PUBLIC_BASE_URL, "https://override.example.test");
assert.equal(configSourceSupervisor.commandEnvironment().DEVSPACE_ALLOWED_ROOTS, undefined);
configSourceSupervisor.beginPolling();
configSourceSupervisor.stopPolling();
const migratedSupervisorState = JSON.parse(fs.readFileSync(
  path.join(temporaryRoot, "config-source-state.json"),
  "utf8",
));
assert.equal(migratedSupervisorState.startupConfigSources.publicBaseUrl, "environment");
assert.equal(migratedSupervisorState.startupConfigSources.allowedRoots, "config.json");

let injectedConfigWrite;
const injectedConfigSupervisor = new WorkbridgeSupervisor({
  monitorUrl: "http://127.0.0.1:9/monitor",
  projectRoot,
  tokenFile: path.join(temporaryRoot, "injected-config-state.json"),
  environment: {},
  readStartupConfigFile: () => ({
    publicBaseUrl: "https://jsonc.example.test",
    allowedRoots: ["C:\\jsonc-workspace"],
    auxiliaryRoots: ["C:\\jsonc-aux"],
    worktreeRoot: "C:\\jsonc-workspace\\.workbridge\\worktrees",
    stateDir: "C:\\jsonc-state",
    trustProxy: true,
  }),
  writeStartupConfigFile: (_file, config) => { injectedConfigWrite = config; },
  configSource: "config.jsonc",
});
assert.equal(injectedConfigSupervisor.status().startupConfigSources.allowedRoots, "config.jsonc");
const injectedSavedConfig = {
  publicBaseUrl: "https://jsonc-saved.example.test",
  allowedRoots: ["C:\\jsonc-saved-workspace"],
  auxiliaryRoots: [],
  worktreeRoot: "C:\\jsonc-saved-workspace\\.workbridge\\worktrees",
  stateDir: "C:\\jsonc-saved-state",
  trustProxy: false,
};
injectedConfigSupervisor.setStartupConfig(injectedSavedConfig);
assert.deepEqual(injectedConfigWrite, injectedSavedConfig);

const startupConfig = {
  publicBaseUrl: "https://wb.example.test",
  allowedRoots: ["C:\\workspace"],
  auxiliaryRoots: ["C:\\Users\\test\\.codex", "C:\\Users\\test\\.agents"],
  worktreeRoot: "C:\\workspace\\.workbridge\\worktrees",
  stateDir: "C:\\custom-workbridge-state",
  trustProxy: true,
};
supervisor.setStartupConfig({ ...startupConfig, ignoredSecret: "must-not-persist" });
supervisor.controlToken = "test-control-token";
supervisor.persistState();
assert.equal(supervisor.status().startupConfigComplete, true);
assert.equal(supervisor.status().capabilities.start, true);
assert.deepEqual(startupConfigEnvironment(startupConfig), {
  DEVSPACE_PUBLIC_BASE_URL: "https://wb.example.test",
  DEVSPACE_ALLOWED_ROOTS: "C:\\workspace",
  WORKBRIDGE_AUXILIARY_ROOTS: "C:\\Users\\test\\.codex,C:\\Users\\test\\.agents",
  DEVSPACE_WORKTREE_ROOT: "C:\\workspace\\.workbridge\\worktrees",
  DEVSPACE_STATE_DIR: "C:\\custom-workbridge-state",
  DEVSPACE_TRUST_PROXY: "1",
});
const commandEnvironment = supervisor.commandEnvironment();
assert.equal(commandEnvironment.DEVSPACE_PUBLIC_BASE_URL, undefined);
assert.equal(commandEnvironment.DEVSPACE_ALLOWED_ROOTS, undefined);
assert.equal(commandEnvironment.WORKBRIDGE_AUXILIARY_ROOTS, undefined);
assert.equal(commandEnvironment.DEVSPACE_WORKTREE_ROOT, undefined);
assert.equal(commandEnvironment.DEVSPACE_STATE_DIR, undefined);
assert.equal(commandEnvironment.DEVSPACE_TRUST_PROXY, undefined);
assert.equal(commandEnvironment.DEVSPACE_CONFIG_DIR, process.env.DEVSPACE_CONFIG_DIR);
assert.equal(commandEnvironment.WORKBRIDGE_MONITOR_PORT, "9");
const restoredSupervisor = new WorkbridgeSupervisor({
  monitorUrl: "http://127.0.0.1:9/monitor",
  projectRoot,
  tokenFile: path.join(temporaryRoot, "token.json"),
});
assert.deepEqual(restoredSupervisor.startupConfig, startupConfig);
assert.equal(restoredSupervisor.controlToken, "test-control-token");

const homeConfigFile = path.join(temporaryRoot, "home-state-config", "config.json");
const homeStateSupervisor = new WorkbridgeSupervisor({
  monitorUrl: "http://127.0.0.1:9/monitor",
  projectRoot,
  tokenFile: path.join(temporaryRoot, "home-state-token.json"),
  configFile: homeConfigFile,
});
homeStateSupervisor.setStartupConfig({ ...startupConfig, stateDir: "~\\.workbridge-state" });
const expectedHomeMemoryDir = path.join(os.homedir(), ".workbridge-state", "monitor-memory", "electron");
assert.equal(homeStateSupervisor.status().memoryLog.directory, expectedHomeMemoryDir);
const restoredHomeStateSupervisor = new WorkbridgeSupervisor({
  monitorUrl: "http://127.0.0.1:9/monitor",
  projectRoot,
  tokenFile: path.join(temporaryRoot, "restored-home-state-token.json"),
  configFile: homeConfigFile,
});
assert.equal(restoredHomeStateSupervisor.status().memoryLog.directory, expectedHomeMemoryDir);
assert.equal(restoredSupervisor.status().stateDir, "C:\\custom-workbridge-state");
assert.deepEqual(
  JSON.parse(fs.readFileSync(path.join(temporaryRoot, "token.json"), "utf8")),
  {
    version: 3,
    controlToken: "test-control-token",
    startupConfig,
    startupConfigSources: {
      publicBaseUrl: "config.json",
      allowedRoots: "config.json",
      auxiliaryRoots: "config.json",
      worktreeRoot: "config.json",
      stateDir: "config.json",
      trustProxy: "config.json",
    },
  },
);

const residualPid = 9876;
const residualSupervisor = new WorkbridgeSupervisor({
  monitorUrl: "http://127.0.0.1:9/monitor",
  projectRoot,
  tokenFile: path.join(temporaryRoot, "residual-token.json"),
  processExists: (pid) => pid === residualPid,
});
residualSupervisor.setStartupConfig(startupConfig);
residualSupervisor.managedChild = { pid: residualPid };
assert.equal(residualSupervisor.status().state, "residual_process");
assert.equal(residualSupervisor.status().ownership, "managed");
assert.equal(residualSupervisor.status().residualProcess, true);
assert.equal(residualSupervisor.status().capabilities.start, false);
assert.equal(residualSupervisor.status().capabilities.stop, true);

supervisor.serverReachable = true;
supervisor.runtimeStatus = {
  server: {
    controlEnabled: false,
    pid: 1234,
    startupConfig: { ...startupConfig, stateDir: "C:\\active-workbridge-state" },
  },
};
assert.equal(supervisor.status().state, "running");
assert.equal(supervisor.status().ownership, "external");
assert.equal(supervisor.status().capabilities.build, true);
assert.equal(supervisor.status().capabilities.pause, true);
assert.equal(supervisor.status().capabilities.resume, false);
assert.equal(supervisor.status().capabilities.stop, false);
assert.equal(supervisor.status().capabilities.restart, false);
assert.equal(supervisor.status().capabilities.buildRestart, false);
assert.equal(supervisor.status().startupConfigMatchesRuntime, false);
assert.equal(supervisor.controlEnvironment().DEVSPACE_STATE_DIR, "C:\\active-workbridge-state");

const pathComparisonConfigFile = path.join(temporaryRoot, "path-comparison", "config.json");
const pathComparisonSupervisor = new WorkbridgeSupervisor({
  monitorUrl: "http://127.0.0.1:9/monitor",
  projectRoot,
  tokenFile: path.join(temporaryRoot, "path-comparison-token.json"),
  configFile: pathComparisonConfigFile,
});
const homeRelativeStartupConfig = {
  publicBaseUrl: "https://paths.example.test",
  allowedRoots: ["~/Documents/Workbridge"],
  auxiliaryRoots: ["~\\.codex", "~/.agents"],
  worktreeRoot: "~/Documents/Workbridge/.workbridge/worktrees/",
  stateDir: "~\\.workbridge-state\\",
  trustProxy: true,
};
pathComparisonSupervisor.setStartupConfig(homeRelativeStartupConfig);
const runtimePath = (value) => {
  const expanded = value.startsWith("~/") || value.startsWith("~\\")
    ? path.join(os.homedir(), value.slice(2))
    : value;
  const normalized = path.normalize(expanded);
  if (process.platform !== "win32") return `${normalized}/`;
  return `${normalized.replace(/\\/g, "/").toUpperCase()}/`;
};
const equivalentRuntimeConfig = {
  ...homeRelativeStartupConfig,
  allowedRoots: homeRelativeStartupConfig.allowedRoots.map(runtimePath),
  auxiliaryRoots: homeRelativeStartupConfig.auxiliaryRoots.map(runtimePath),
  worktreeRoot: runtimePath(homeRelativeStartupConfig.worktreeRoot),
  stateDir: runtimePath(homeRelativeStartupConfig.stateDir),
};
pathComparisonSupervisor.serverReachable = true;
pathComparisonSupervisor.runtimeStatus = { server: { startupConfig: equivalentRuntimeConfig } };
assert.equal(pathComparisonSupervisor.status().startupConfigMatchesRuntime, true);
pathComparisonSupervisor.runtimeStatus = {
  server: { startupConfig: { ...equivalentRuntimeConfig, allowedRoots: [runtimePath("~/Documents/Other")] } },
};
assert.equal(pathComparisonSupervisor.status().startupConfigMatchesRuntime, false);
pathComparisonSupervisor.runtimeStatus = {
  server: { startupConfig: { ...equivalentRuntimeConfig, stateDir: runtimePath("~/.other-workbridge-state") } },
};
assert.equal(pathComparisonSupervisor.status().startupConfigMatchesRuntime, false);
pathComparisonSupervisor.runtimeStatus = {
  server: { startupConfig: { ...equivalentRuntimeConfig, trustProxy: false } },
};
assert.equal(pathComparisonSupervisor.status().startupConfigMatchesRuntime, false);

void (async () => {
  const exitedChild = new EventEmitter();
  exitedChild.pid = 24601;
  exitedChild.exitCode = 7;
  exitedChild.signalCode = null;
  await assert.rejects(
    () => waitForServerStartup(exitedChild, async () => false, 1_000),
    /exited before the Session Monitor became ready \(exit code 7\)/,
  );

  let controlledProcessAlive = true;
  setTimeout(() => { controlledProcessAlive = false; }, 20);
  await waitForProcessExit(() => controlledProcessAlive, 7654, 1_000);
  await assert.rejects(
    () => waitForProcessExit(() => true, 7655, 5),
    /Controlled Workbridge process 7655 remained alive after shutdown/,
  );

  const observedConfig = {
    publicBaseUrl: "https://observed.example.test",
    allowedRoots: ["C:\\observed-workspace"],
    auxiliaryRoots: ["C:\\observed-auxiliary"],
    worktreeRoot: "C:\\observed-workspace\\.workbridge\\worktrees",
    stateDir: "C:\\observed-state",
    trustProxy: true,
  };
  let desktopMemorySamples = 0;
  const memoryLogRecords = [];
  const fakeMemoryLogger = {
    record: (value) => { memoryLogRecords.push(value); return Promise.resolve(true); },
    status: () => ({ enabled: true, intervalMs: 30_000, retentionDays: 30, lastError: null }),
    setStateDir: () => {},
  };
  const desktopMemorySupervisor = new WorkbridgeSupervisor({
    monitorUrl: "http://127.0.0.1:9/monitor",
    projectRoot,
    tokenFile: path.join(temporaryRoot, "desktop-memory-state.json"),
    memoryLogger: fakeMemoryLogger,
    desktopMemoryProvider: () => {
      desktopMemorySamples += 1;
      return {
        sampledAt: Date.now(),
        workingSetBytes: 123,
        privateBytes: 45,
        peakWorkingSetBytes: 123,
        processes: [],
        system: { totalBytes: 1_000, freeBytes: 250, usedBytes: 750 },
      };
    },
  });
  await desktopMemorySupervisor.refreshRuntimeStatus();
  assert.equal(desktopMemorySamples, 1);
  assert.equal(memoryLogRecords.length, 1);
  assert.equal(memoryLogRecords[0].desktopMemory.workingSetBytes, 123);
  assert.equal(memoryLogRecords[0].serverReachable, false);
  assert.equal(desktopMemorySupervisor.status().desktopMemory.workingSetBytes, 123);
  assert.equal(desktopMemorySupervisor.status().memoryLog.enabled, true);
  await desktopMemorySupervisor.refreshRuntimeStatus();
  assert.equal(desktopMemorySamples, 1);
  assert.equal(memoryLogRecords.length, 1);
  desktopMemorySupervisor.lastDesktopMemorySampleAt = 0;
  await desktopMemorySupervisor.refreshRuntimeStatus();
  assert.equal(desktopMemorySamples, 2);
  assert.equal(memoryLogRecords.length, 2);

  let deferredMemorySamples = 0;
  const deferredMemorySupervisor = new WorkbridgeSupervisor({
    monitorUrl: "http://127.0.0.1:9/monitor",
    projectRoot,
    tokenFile: path.join(temporaryRoot, "deferred-desktop-memory-state.json"),
    desktopMemoryProvider: () => {
      deferredMemorySamples += 1;
      if (deferredMemorySamples === 1) return undefined;
      return {
        sampledAt: Date.now(),
        workingSetBytes: 321,
        privateBytes: 123,
        peakWorkingSetBytes: 321,
        processes: [],
        system: { totalBytes: 1_000, freeBytes: 200, usedBytes: 800 },
      };
    },
  });
  await deferredMemorySupervisor.refreshRuntimeStatus();
  assert.equal(deferredMemorySamples, 1);
  assert.equal(deferredMemorySupervisor.status().desktopMemory, undefined);
  await deferredMemorySupervisor.refreshRuntimeStatus();
  assert.equal(deferredMemorySamples, 2);
  assert.equal(deferredMemorySupervisor.status().desktopMemory.workingSetBytes, 321);

  const runtimeServer = http.createServer((request, response) => {
    if (request.url !== "/monitor/api/status") {
      response.writeHead(404).end();
      return;
    }
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({
      server: {
        controlEnabled: false,
        pid: 4321,
        startupConfig: observedConfig,
      },
    }));
  });
  await new Promise((resolve, reject) => {
    runtimeServer.once("listening", resolve);
    runtimeServer.once("error", reject);
    runtimeServer.listen(0, "127.0.0.1");
  });
  try {
    const address = runtimeServer.address();
    const incompleteStateFile = path.join(temporaryRoot, "incomplete-observed-state.json");
    fs.writeFileSync(incompleteStateFile, JSON.stringify({
      version: 3,
      startupConfig: { stateDir: "C:\\stale-state" },
    }), "utf8");
    const incompleteSupervisor = new WorkbridgeSupervisor({
      monitorUrl: `http://127.0.0.1:${address.port}/monitor`,
      projectRoot,
      tokenFile: incompleteStateFile,
    });
    await incompleteSupervisor.refreshRuntimeStatus();
    assert.deepEqual(incompleteSupervisor.startupConfig, startupConfig);
    assert.deepEqual(incompleteSupervisor.status().startupConfigSources, {
      publicBaseUrl: "config.json",
      allowedRoots: "config.json",
      auxiliaryRoots: "config.json",
      worktreeRoot: "config.json",
      stateDir: "config.json",
      trustProxy: "config.json",
    });

    const observedStateFile = path.join(temporaryRoot, "observed-state.json");
    fs.writeFileSync(observedStateFile, JSON.stringify({
      version: 3,
      startupConfig: {
        publicBaseUrl: observedConfig.publicBaseUrl,
        allowedRoots: observedConfig.allowedRoots,
        stateDir: observedConfig.stateDir,
        trustProxy: observedConfig.trustProxy,
      },
    }), "utf8");
    const observedSupervisor = new WorkbridgeSupervisor({
      monitorUrl: `http://127.0.0.1:${address.port}/monitor`,
      projectRoot,
      tokenFile: observedStateFile,
    });
    await observedSupervisor.refreshRuntimeStatus();
    assert.deepEqual(observedSupervisor.startupConfig, startupConfig);
    assert.equal(observedSupervisor.status().startupConfigComplete, true);
    assert.deepEqual(observedSupervisor.status().startupConfigSources, {
      publicBaseUrl: "config.json",
      allowedRoots: "config.json",
      auxiliaryRoots: "config.json",
      worktreeRoot: "config.json",
      stateDir: "config.json",
      trustProxy: "config.json",
    });
    assert.deepEqual(
      JSON.parse(fs.readFileSync(observedStateFile, "utf8")).startupConfig,
      {
        publicBaseUrl: observedConfig.publicBaseUrl,
        allowedRoots: observedConfig.allowedRoots,
        stateDir: observedConfig.stateDir,
        trustProxy: observedConfig.trustProxy,
      },
    );

    const actionLogFile = path.join(temporaryRoot, "actions.jsonl");
    const actionSupervisor = new WorkbridgeSupervisor({
      monitorUrl: "http://127.0.0.1:9/monitor",
      projectRoot,
      tokenFile: path.join(temporaryRoot, "action-state.json"),
      actionLogFile,
    });
    actionSupervisor.refreshRuntimeStatus = async () => undefined;
    actionSupervisor.build = async () => undefined;
    await actionSupervisor.runAction("build");
    const actionEvents = fs.readFileSync(actionLogFile, "utf8")
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line));
    assert.deepEqual(actionEvents.map((entry) => entry.event), [
      "monitor_action_started",
      "monitor_action_completed",
    ]);
    assert.equal(actionEvents[0].action, "build");
    assert.equal(actionEvents[0].source, "renderer");

    let resumeControl;
    const resumeSupervisor = new WorkbridgeSupervisor({
      monitorUrl: "http://127.0.0.1:9/monitor",
      projectRoot,
      tokenFile: path.join(temporaryRoot, "resume-state.json"),
    });
    resumeSupervisor.runtimeStatus = {
      softPause: { version: 1, requestedAt: new Date().toISOString() },
    };
    resumeSupervisor.refreshRuntimeStatus = async () => undefined;
    resumeSupervisor.runCliControl = async (subcommand) => { resumeControl = subcommand; };
    assert.equal(resumeSupervisor.status().capabilities.pause, false);
    assert.equal(resumeSupervisor.status().capabilities.resume, true);
    await resumeSupervisor.runAction("resume");
    assert.equal(resumeControl, "resume");

    const spawnLogFile = path.join(temporaryRoot, "spawn-actions.jsonl");
    let spawnOptions;
    const spawnSupervisor = new WorkbridgeSupervisor({
      monitorUrl: "http://127.0.0.1:9/monitor",
      projectRoot,
      tokenFile: path.join(temporaryRoot, "spawn-state.json"),
      actionLogFile: spawnLogFile,
      spawnProcess: (_command, _args, options) => {
        spawnOptions = options;
        const child = new EventEmitter();
        child.pid = 5432;
        child.stdout = new PassThrough();
        child.stderr = new PassThrough();
        queueMicrotask(() => child.emit("exit", 0, null));
        return child;
      },
    });
    await spawnSupervisor.runCommand("C:\\Program Files\\nodejs\\node.exe", ["secret-argument"], {
      purpose: "pause",
    });
    assert.equal(spawnOptions.windowsHide, true);
    const spawnEvent = JSON.parse(fs.readFileSync(spawnLogFile, "utf8").trim());
    assert.equal(spawnEvent.event, "monitor_process_spawned");
    assert.equal(spawnEvent.source, "renderer");
    assert.equal(spawnEvent.purpose, "pause");
    assert.equal(spawnEvent.executable, "node.exe");
    assert.equal(spawnEvent.pid, 5432);
    assert.equal("args" in spawnEvent, false);
    assert.equal("command" in spawnEvent, false);
    assert.equal("env" in spawnEvent, false);

    if (process.platform === "win32") {
      fs.mkdirSync(path.join(projectRoot, "scripts"), { recursive: true });
      fs.writeFileSync(
        path.join(projectRoot, "scripts", "workbridge-secure-tunnel-runtime-windows.ps1"),
        "",
        "utf8",
      );
      let tunnelEnsureInvocation;
      const tunnelEnsureSupervisor = new WorkbridgeSupervisor({
        monitorUrl: "http://127.0.0.1:9/monitor",
        projectRoot,
        tokenFile: path.join(temporaryRoot, "tunnel-ensure-state.json"),
      });
      tunnelEnsureSupervisor.runCommand = async (command, args, options) => {
        tunnelEnsureInvocation = { command, args, options };
      };
      await tunnelEnsureSupervisor.ensureSecureTunnel();
      assert.equal(tunnelEnsureInvocation.command, "powershell.exe");
      assert.deepEqual(tunnelEnsureInvocation.args.slice(-2), ["-Action", "ensure"]);
      assert.equal(tunnelEnsureInvocation.options.purpose, "tunnel-ensure");
    }

    const signals = [];
    const terminationLogFile = path.join(temporaryRoot, "termination-actions.jsonl");
    const terminationSupervisor = new WorkbridgeSupervisor({
      monitorUrl: "http://127.0.0.1:9/monitor",
      projectRoot,
      tokenFile: path.join(temporaryRoot, "termination-state.json"),
      actionLogFile: terminationLogFile,
      processExists: () => true,
      managedProcessExitGraceMs: 1,
      managedProcessForceExitMs: 1,
    });
    const managedChild = new EventEmitter();
    managedChild.pid = 2468;
    managedChild.exitCode = null;
    managedChild.signalCode = null;
    managedChild.kill = (signal) => {
        signals.push(signal);
        if (signal === "SIGKILL") {
          managedChild.signalCode = signal;
          managedChild.emit("exit", null, signal);
        }
        return true;
    };
    terminationSupervisor.runtimeStatus = { server: { pid: 9999 } };
    await terminationSupervisor.ensureManagedProcessExit(managedChild);
    assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
    const terminationEvents = fs.readFileSync(terminationLogFile, "utf8")
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line));
    assert.deepEqual(terminationEvents.map((entry) => entry.event), [
      "monitor_residual_process_detected",
      "monitor_residual_process_terminated",
    ]);
    assert.equal(terminationEvents[1].signal, "SIGKILL");

    const racedSupervisor = new WorkbridgeSupervisor({
      monitorUrl: "http://127.0.0.1:9/monitor",
      projectRoot,
      tokenFile: path.join(temporaryRoot, "raced-state.json"),
    });
    const racedChild = new EventEmitter();
    racedChild.pid = 1357;
    racedChild.exitCode = 0;
    racedChild.signalCode = null;
    racedChild.kill = () => {
      throw new Error("must not signal an exited child");
    };
    assert.doesNotThrow(() => racedSupervisor.signalManagedProcess(racedChild, "SIGTERM"));
  } finally {
    await new Promise((resolve) => runtimeServer.close(resolve));
  }
  fs.rmSync(temporaryRoot, { recursive: true, force: true });
  console.log("desktop supervisor tests passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
