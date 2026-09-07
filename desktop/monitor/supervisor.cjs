"use strict";

const { spawn } = require("node:child_process");
const { randomUUID } = require("node:crypto");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const http = require("node:http");
const https = require("node:https");
const os = require("node:os");
const path = require("node:path");
const { MemoryHistoryLogger } = require("./memory-log.cjs");

const SUPPORTED_ACTIONS = new Set([
  "start",
  "stop",
  "restart",
  "build",
  "build-restart",
  "pause",
  "resume",
]);
const MANAGED_PROCESS_EXIT_GRACE_MS = 3_000;
const MANAGED_PROCESS_FORCE_EXIT_MS = 2_000;
const DEFAULT_STARTUP_TIMEOUT_MS = 45_000;
const DEFAULT_DESKTOP_MEMORY_SAMPLE_INTERVAL_MS = 5_000;

class WorkbridgeSupervisor extends EventEmitter {
  constructor(options) {
    super();
    this.monitorUrl = options.monitorUrl;
    this.projectRoot = options.projectRoot;
    this.tokenFile = options.tokenFile;
    this.monitorRelaunchRequestFile = options.monitorRelaunchRequestFile
      || path.join(path.dirname(this.tokenFile), "monitor-relaunch-request.json");
    this.actionLogFile = options.actionLogFile || path.join(path.dirname(this.tokenFile), "monitor-actions.jsonl");
    this.spawnProcess = options.spawnProcess || spawn;
    this.environment = options.environment || process.env;
    this.configFile = options.configFile || startupConfigFile(this.environment);
    this.readStartupConfigFile = options.readStartupConfigFile || readStartupConfigFile;
    this.writeStartupConfigFile = options.writeStartupConfigFile || writeStartupConfigFile;
    this.configSource = options.configSource || "config.json";
    this.processExists = options.processExists || processExists;
    this.managedProcessExitGraceMs = options.managedProcessExitGraceMs ?? MANAGED_PROCESS_EXIT_GRACE_MS;
    this.managedProcessForceExitMs = options.managedProcessForceExitMs ?? MANAGED_PROCESS_FORCE_EXIT_MS;
    this.startupTimeoutMs = options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;
    this.desktopMemoryProvider = typeof options.desktopMemoryProvider === "function"
      ? options.desktopMemoryProvider
      : undefined;
    this.desktopMemorySampleIntervalMs = options.desktopMemorySampleIntervalMs
      ?? DEFAULT_DESKTOP_MEMORY_SAMPLE_INTERVAL_MS;
    const persistedState = readPersistedState(this.tokenFile);
    this.controlToken = persistedState.controlToken;
    this.configuredStartupConfig = safeNormalizeStartupConfig(this.readStartupConfigFile(this.configFile));
    const environmentStartupConfig = safeNormalizeStartupConfig(startupConfigFromEnvironment(this.environment));
    this.environmentStartupConfig = environmentStartupConfig;
    this.startupConfig = mergeStartupConfigs(
      this.configuredStartupConfig,
      environmentStartupConfig,
    );
    this.startupConfigSources = mergeStartupConfigSources(
      startupConfigSourcesFor(this.configuredStartupConfig, this.configSource),
      startupConfigSourcesFor(environmentStartupConfig, "environment"),
    );
    this.stateDir = this.startupConfig.stateDir;
    this.memoryLogger = options.memoryLogger || new MemoryHistoryLogger({
      stateDir: expandHome(this.stateDir),
      shell: "electron",
      runtime: options.memoryLogRuntime || {},
    });
    this.runtimeStatus = undefined;
    this.serverReachable = false;
    this.managedChild = undefined;
    this.operation = undefined;
    this.lastResult = undefined;
    this.pollTimer = undefined;
    this.desktopMemory = undefined;
    this.lastDesktopMemorySampleAt = 0;
  }

  beginPolling(intervalMs = 1000) {
    if (this.pollTimer) return;
    this.persistState();
    void this.refreshRuntimeStatus();
    this.pollTimer = setInterval(() => void this.refreshRuntimeStatus(), intervalMs);
    this.pollTimer.unref?.();
  }

  stopPolling() {
    if (!this.pollTimer) return;
    clearInterval(this.pollTimer);
    this.pollTimer = undefined;
  }

  async refreshRuntimeStatus() {
    this.consumeMonitorRelaunchRequest();
    const desktopMemorySample = this.sampleDesktopMemory();
    const runtimeStatus = await requestJson(runtimeStatusUrl(this.monitorUrl), { timeoutMs: 1000 });
    this.serverReachable = Boolean(runtimeStatus);
    this.runtimeStatus = runtimeStatus || undefined;
    if (desktopMemorySample) {
      void this.memoryLogger.record({
        desktopMemory: desktopMemorySample,
        runtimeStatus: this.runtimeStatus,
        serverReachable: this.serverReachable,
      });
    }
    this.emitStatus();
    return this.runtimeStatus;
  }

  consumeMonitorRelaunchRequest() {
    if (!fs.existsSync(this.monitorRelaunchRequestFile)) return false;
    fs.rmSync(this.monitorRelaunchRequestFile, { force: true });
    this.recordActionEvent("monitor_relaunch_requested", { source: "managed_restart" });
    this.emit("monitor-relaunch-requested");
    return true;
  }

  status() {
    const runtimeServer = this.runtimeStatus?.server;
    const startupReady = startupConfigIsComplete(this.startupConfig);
    const paused = Boolean(this.runtimeStatus?.softPause);
    const managedPid = this.managedChild?.pid;
    const residualProcess = !this.serverReachable
      && Number.isInteger(managedPid)
      && this.processExists(managedPid);
    const controllable = Boolean(
      this.serverReachable
      && runtimeServer?.controlEnabled
      && this.controlToken,
    );
    const ownership = residualProcess
      ? "managed"
      : this.serverReachable
      ? (controllable || this.managedChild ? "managed" : "external")
      : "none";
    let state = this.serverReachable ? "running" : "stopped";
    if (this.operation?.active) state = operationState(this.operation.action, this.operation.phase);
    else if (residualProcess) state = "residual_process";
    else if (this.lastResult?.ok === false && !this.serverReachable) state = "error";

    return {
      version: 1,
      projectRoot: this.projectRoot,
      state,
      ownership,
      serverReachable: this.serverReachable,
      managedPid,
      residualProcess,
      stateDir: this.stateDir,
      desktopMemory: this.desktopMemory,
      memoryLog: this.memoryLogger.status(),
      configuredStartupConfig: cloneStartupConfig(this.configuredStartupConfig),
      startupConfig: cloneStartupConfig(this.startupConfig),
      startupConfigSources: { ...this.startupConfigSources },
      startupConfigComplete: startupConfigIsComplete(this.startupConfig),
      startupConfigMatchesRuntime: startupConfigsEqual(
        this.startupConfig,
        safeNormalizeStartupConfig(runtimeServer?.startupConfig),
      ),
      runtimeStatus: this.runtimeStatus,
      operation: this.operation,
      lastResult: this.lastResult,
      capabilities: {
        start: !this.serverReachable && !residualProcess && startupReady,
        stop: controllable || Boolean(this.managedChild),
        restart: startupReady && (controllable || Boolean(this.managedChild)),
        build: true,
        buildRestart: startupReady && (!this.serverReachable || controllable || Boolean(this.managedChild)),
        pause: !paused,
        resume: paused,
      },
    };
  }

  sampleDesktopMemory() {
    if (!this.desktopMemoryProvider) return;
    const now = Date.now();
    if (this.lastDesktopMemorySampleAt
      && now - this.lastDesktopMemorySampleAt < this.desktopMemorySampleIntervalMs) return;
    try {
      const snapshot = this.desktopMemoryProvider();
      if (snapshot === undefined || snapshot === null) return;
      this.desktopMemory = snapshot;
      this.lastDesktopMemorySampleAt = now;
      return snapshot;
    } catch {
      this.desktopMemory = undefined;
      return undefined;
    }
  }

  async runAction(action) {
    if (!SUPPORTED_ACTIONS.has(action)) throw new Error(`Unsupported monitor action: ${action}`);
    if (this.operation?.active) throw new Error(`Another operation is already running: ${this.operation.action}`);
    const initialManagedPid = this.runtimeStatus?.server?.pid ?? this.managedChild?.pid;
    this.operation = {
      active: true,
      action,
      phase: action,
      startedAt: Date.now(),
      line: "",
    };
    this.lastResult = undefined;
    this.recordActionEvent("monitor_action_started", {
      action,
      managedPid: initialManagedPid,
    });
    this.emitStatus();

    try {
      switch (action) {
        case "pause":
          await this.runCliControl("pause", ["--reason", "Requested from Workbridge Session Monitor"]);
          break;
        case "resume":
          await this.runCliControl("resume");
          break;
        case "build":
          await this.build();
          break;
        case "start":
          await this.startServer();
          break;
        case "stop":
          await this.stopServer();
          break;
        case "restart":
          await this.restartServer();
          break;
        case "build-restart":
          await this.build();
          await this.restartServer();
          break;
      }
      this.lastResult = {
        action,
        ok: true,
        completedAt: Date.now(),
        durationMs: Date.now() - this.operation.startedAt,
        line: this.operation.line,
      };
      this.recordActionEvent("monitor_action_completed", {
        action,
        managedPid: initialManagedPid,
        durationMs: this.lastResult.durationMs,
      });
      return this.status();
    } catch (error) {
      this.lastResult = {
        action,
        ok: false,
        completedAt: Date.now(),
        durationMs: Date.now() - this.operation.startedAt,
        error: error instanceof Error ? error.message : String(error),
        line: this.operation.line,
      };
      this.recordActionEvent("monitor_action_failed", {
        action,
        managedPid: initialManagedPid,
        durationMs: this.lastResult.durationMs,
        error: this.lastResult.error,
      });
      throw error;
    } finally {
      this.operation = undefined;
      await this.refreshRuntimeStatus();
      this.emitStatus();
    }
  }

  setStartupConfig(value) {
    const startupConfig = normalizeStartupConfig(value, { requireComplete: true });
    this.writeStartupConfigFile(this.configFile, startupConfig);
    this.configuredStartupConfig = startupConfig;
    this.startupConfig = mergeStartupConfigs(startupConfig, this.environmentStartupConfig);
    this.startupConfigSources = mergeStartupConfigSources(
      startupConfigSourcesFor(startupConfig, this.configSource),
      startupConfigSourcesFor(this.environmentStartupConfig, "environment"),
    );
    this.stateDir = this.startupConfig.stateDir;
    this.memoryLogger.setStateDir(expandHome(this.stateDir));
    this.persistState();
    this.emitStatus();
    return this.status();
  }

  async build() {
    this.setPhase("building", "Running npm run build…");
    const invocation = npmInvocation(["run", "build"]);
    await this.runCommand(invocation.command, invocation.args, { purpose: "build" });
  }

  async startServer() {
    await this.refreshRuntimeStatus();
    if (this.serverReachable) throw new Error("Workbridge is already running.");
    if (Number.isInteger(this.managedChild?.pid) && this.processExists(this.managedChild.pid)) {
      throw new Error("A residual managed Workbridge process is still running. Use Restart to replace it safely.");
    }
    if (!startupConfigIsComplete(this.startupConfig)) {
      throw new Error("Startup Config is incomplete. Save all four startup settings before starting Workbridge.");
    }
    this.controlToken = randomUUID();
    this.persistState();
    const command = nodeCommand();
    const child = this.spawnAuditedProcess("start", command, ["dist/cli.js", "serve"], {
      cwd: this.projectRoot,
      env: this.commandEnvironment({
        WORKBRIDGE_MONITOR_CONTROL_TOKEN: this.controlToken,
      }),
      windowsHide: true,
      detached: true,
      stdio: "ignore",
    });
    this.managedChild = child;
    this.setPhase("starting", "Starting Workbridge…");
    child.unref?.();
    this.attachManagedChild(child);
    await waitForServerStartup(
      child,
      async () => Boolean(await requestJson(runtimeStatusUrl(this.monitorUrl), { timeoutMs: 700 })),
      this.startupTimeoutMs,
    );
    await this.refreshRuntimeStatus();
    try {
      await this.ensureSecureTunnel();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Workbridge started, but Secure Tunnel auto-start failed: ${message}`);
    }
  }

  async ensureSecureTunnel() {
    if (process.platform !== "win32") return;
    const script = path.join(this.projectRoot, "scripts", "workbridge-secure-tunnel-runtime-windows.ps1");
    if (!fs.existsSync(script)) return;
    this.setPhase("starting", "Ensuring Secure Tunnel…");
    await this.runCommand(
      "powershell.exe",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script, "-Action", "ensure"],
      { purpose: "tunnel-ensure", env: this.commandEnvironment() },
    );
  }

  async stopServer() {
    await this.refreshRuntimeStatus();
    if (!this.serverReachable && !this.managedChild) return;
    if (!this.controlToken) throw new Error("This Workbridge process is external and cannot be stopped safely.");
    const managedChild = this.managedChild;
    const runtimePid = this.runtimeStatus?.server?.pid;
    this.setPhase("stopping", "Stopping Workbridge…");
    const response = await requestJson(controlShutdownUrl(this.monitorUrl), {
      method: "POST",
      token: this.controlToken,
      timeoutMs: 1500,
      acceptStatuses: [202],
    });
    if (!response) {
      if (!managedChild) {
        throw new Error("The running Workbridge process is external or uses a different control token.");
      }
      managedChild.kill();
    }
    await waitFor(async () => !(await requestJson(runtimeStatusUrl(this.monitorUrl), { timeoutMs: 500 })), 10_000);
    if (managedChild) {
      await this.ensureManagedProcessExit(managedChild);
    } else if (Number.isInteger(runtimePid)) {
      await waitForProcessExit(
        this.processExists,
        runtimePid,
        this.managedProcessExitGraceMs,
      );
    }
    this.serverReachable = false;
    this.runtimeStatus = undefined;
    this.managedChild = undefined;
  }

  async restartServer() {
    await this.refreshRuntimeStatus();
    if (this.serverReachable || this.managedChild) await this.stopServer();
    await this.startServer();
  }

  async runCliControl(subcommand, extra = []) {
    await this.refreshRuntimeStatus();
    this.setPhase(subcommand === "resume" ? "resuming" : "pausing", `Running control ${subcommand}…`);
    await this.runCommand(
      nodeCommand(),
      ["dist/cli.js", "control", subcommand, ...extra],
      { env: this.controlEnvironment(), purpose: subcommand },
    );
  }

  runCommand(command, args, options = {}) {
    return new Promise((resolve, reject) => {
      const child = this.spawnAuditedProcess(options.purpose || "command", command, args, {
        cwd: this.projectRoot,
        env: options.env || this.commandEnvironment(),
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      this.attachOperationOutput(child);
      child.once("error", reject);
      child.once("exit", (code, signal) => {
        if (code === 0) resolve();
        else reject(new Error(`${command} exited with ${code ?? signal ?? "unknown"}.`));
      });
    });
  }

  spawnAuditedProcess(purpose, command, args, options) {
    const child = this.spawnProcess(command, args, options);
    this.recordActionEvent("monitor_process_spawned", {
      purpose,
      executable: executableName(command),
      ...(Number.isInteger(child?.pid) ? { pid: child.pid } : {}),
    });
    return child;
  }

  commandEnvironment(extra = {}) {
    return {
      ...this.environment,
      ...monitorPortEnvironment(this.monitorUrl),
      ...extra,
    };
  }

  controlEnvironment() {
    const activeStateDir = normalizePathValue(
      this.runtimeStatus?.server?.startupConfig?.stateDir
      ?? this.runtimeStatus?.server?.stateDir,
    ) ?? this.startupConfig.stateDir;
    return {
      ...process.env,
      ...(activeStateDir ? { DEVSPACE_STATE_DIR: activeStateDir } : {}),
    };
  }

  persistState() {
    persistSupervisorState(this.tokenFile, {
      controlToken: this.controlToken,
      startupConfig: this.startupConfig,
      startupConfigSources: this.startupConfigSources,
    });
  }

  recordActionEvent(event, fields = {}) {
    try {
      fs.mkdirSync(path.dirname(this.actionLogFile), { recursive: true });
      fs.appendFileSync(this.actionLogFile, `${JSON.stringify({
        ts: new Date().toISOString(),
        event,
        source: "renderer",
        ...fields,
      })}\n`, "utf8");
    } catch (error) {
      console.error("failed to write Workbridge Monitor action log", error);
    }
  }

  async ensureManagedProcessExit(child) {
    const pid = child?.pid;
    if (!Number.isInteger(pid) || managedChildExited(child)) return;
    if (await waitForManagedChildExit(child, this.managedProcessExitGraceMs)) return;
    this.recordActionEvent("monitor_residual_process_detected", { managedPid: pid });
    this.signalManagedProcess(child, "SIGTERM");
    if (await waitForManagedChildExit(child, this.managedProcessForceExitMs)) {
      this.recordActionEvent("monitor_residual_process_terminated", {
        managedPid: pid,
        signal: "SIGTERM",
      });
      return;
    }
    this.signalManagedProcess(child, "SIGKILL");
    if (await waitForManagedChildExit(child, this.managedProcessForceExitMs)) {
      this.recordActionEvent("monitor_residual_process_terminated", {
        managedPid: pid,
        signal: "SIGKILL",
      });
      return;
    }
    throw new Error(`Managed Workbridge process ${pid} remained alive after forced termination.`);
  }

  signalManagedProcess(child, signal) {
    if (managedChildExited(child)) return;
    try {
      child.kill(signal);
    } catch (error) {
      if (!managedChildExited(child)) throw error;
    }
  }

  attachManagedChild(child) {
    child.once("exit", () => {
      if (this.managedChild === child) this.managedChild = undefined;
      void this.refreshRuntimeStatus();
    });
    child.once("error", (error) => {
      this.setOperationLine(error instanceof Error ? error.message : String(error));
    });
  }

  attachOperationOutput(child) {
    for (const stream of [child.stdout, child.stderr]) {
      if (!stream) continue;
      let buffer = "";
      stream.setEncoding("utf8");
      stream.on("data", (chunk) => {
        buffer += String(chunk);
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() || "";
        for (const line of lines) if (line.trim()) this.setOperationLine(line.trim());
      });
      stream.on("end", () => {
        if (buffer.trim()) this.setOperationLine(buffer.trim());
      });
    }
  }

  setPhase(phase, line) {
    if (!this.operation) return;
    this.operation.phase = phase;
    this.operation.line = line;
    this.emitStatus();
  }

  setOperationLine(line) {
    if (!this.operation) return;
    this.operation.line = String(line).slice(-500);
    this.emitStatus();
  }

  emitStatus() {
    this.emit("status", this.status());
  }
}

function resolveWorkbridgeProjectRoot(explicit, candidates = []) {
  const search = [explicit, ...candidates].filter(Boolean);
  for (const candidate of search) {
    let current = path.resolve(candidate);
    for (let depth = 0; depth < 8; depth += 1) {
      if (isWorkbridgeRoot(current)) return current;
      const parent = path.dirname(current);
      if (parent === current) break;
      current = parent;
    }
  }
  throw new Error("Unable to locate the Workbridge project root. Set WORKBRIDGE_PROJECT_ROOT.");
}

function isWorkbridgeRoot(candidate) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(candidate, "package.json"), "utf8"));
    return pkg?.name === "@waishnav/devspace" && fs.existsSync(path.join(candidate, "src"));
  } catch {
    return false;
  }
}

function runtimeStatusUrl(monitorUrl) {
  return new URL("/monitor/api/status", new URL(monitorUrl).origin).toString();
}

function controlShutdownUrl(monitorUrl) {
  return new URL("/monitor/api/control/shutdown", new URL(monitorUrl).origin).toString();
}

function requestJson(url, options = {}) {
  return new Promise((resolve) => {
    const parsed = new URL(url);
    const client = parsed.protocol === "https:" ? https : http;
    const request = client.request(parsed, {
      method: options.method || "GET",
      headers: {
        accept: "application/json",
        "user-agent": "Workbridge-Monitor-Desktop",
        ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
      },
      timeout: options.timeoutMs || 1000,
    }, (response) => {
      const accepted = options.acceptStatuses || [200];
      if (!response.statusCode || !accepted.includes(response.statusCode)) {
        response.resume();
        resolve(undefined);
        return;
      }
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { body += chunk; });
      response.on("end", () => {
        try { resolve(body ? JSON.parse(body) : {}); }
        catch { resolve(undefined); }
      });
    });
    request.once("timeout", () => { request.destroy(); resolve(undefined); });
    request.once("error", () => resolve(undefined));
    request.end();
  });
}

async function waitForServerStartup(child, check, timeoutMs = DEFAULT_STARTUP_TIMEOUT_MS) {
  await waitFor(async () => {
    if (managedChildExited(child)) {
      const detail = child.signalCode
        ? `signal ${child.signalCode}`
        : `exit code ${child.exitCode ?? "unknown"}`;
      throw new Error(`Workbridge exited before the Session Monitor became ready (${detail}).`);
    }
    return await check();
  }, timeoutMs, `Timed out waiting for Workbridge startup after ${Math.ceil(timeoutMs / 1000)} seconds.`);
}

async function waitFor(check, timeoutMs, timeoutMessage = "Timed out waiting for the Workbridge process state to change.") {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(timeoutMessage);
}

function managedChildExited(child) {
  return child?.exitCode !== null && child?.exitCode !== undefined
    || child?.signalCode !== null && child?.signalCode !== undefined;
}

async function waitForManagedChildExit(child, timeoutMs) {
  if (managedChildExited(child)) return true;
  return await new Promise((resolve) => {
    let settled = false;
    let timeout;
    const finish = (exited) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      child.removeListener?.("exit", onExit);
      resolve(exited);
    };
    const onExit = () => finish(true);
    child.once?.("exit", onExit);
    timeout = setTimeout(() => finish(managedChildExited(child)), timeoutMs);
    timeout.unref?.();
  });
}

async function waitForProcessExit(processExistsFn, pid, timeoutMs) {
  await waitFor(
    async () => !processExistsFn(pid),
    timeoutMs,
    `Controlled Workbridge process ${pid} remained alive after shutdown.`,
  );
}

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function operationState(action, phase) {
  if (phase === "building" || action === "build") return "building";
  if (phase === "starting") return "starting";
  if (phase === "stopping") return "stopping";
  if (action === "restart" || action === "build-restart") return "restarting";
  if (phase === "pausing") return "pausing";
  if (phase === "resuming") return "resuming";
  return "working";
}

function nodeCommand() {
  return process.env.WORKBRIDGE_NODE_COMMAND?.trim() || "node";
}

function executableName(command) {
  const value = String(command);
  return value.includes("\\") ? path.win32.basename(value) : path.basename(value);
}

function npmInvocation(args) {
  if (process.platform === "win32") {
    return {
      command: process.env.ComSpec || "cmd.exe",
      args: ["/d", "/s", "/c", ["npm", ...args].join(" ")],
    };
  }
  return { command: "npm", args };
}

function readPersistedState(file) {
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    return {
      controlToken: typeof value?.controlToken === "string" ? value.controlToken : undefined,
      startupConfig: mergeStartupConfigs(
        safeNormalizeStartupConfig({ stateDir: value?.stateDir }),
        safeNormalizeStartupConfig(value?.startupConfig),
      ),
      startupConfigSources: normalizeStartupConfigSources(value?.startupConfigSources),
    };
  } catch {
    return {};
  }
}

function persistSupervisorState(file, state) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({
    version: 3,
    ...(state.controlToken ? { controlToken: state.controlToken } : {}),
    ...(Object.keys(state.startupConfig || {}).length > 0
      ? { startupConfig: cloneStartupConfig(state.startupConfig) }
      : {}),
    ...(Object.keys(state.startupConfigSources || {}).length > 0
      ? { startupConfigSources: { ...state.startupConfigSources } }
      : {}),
  }), "utf8");
}

function startupConfigFile(env) {
  const configuredDir = env.DEVSPACE_CONFIG_DIR?.trim();
  const dir = configuredDir
    ? expandHome(configuredDir)
    : path.join(os.homedir(), ".devspace");
  return path.join(path.resolve(dir), "config.json");
}

function expandHome(value) {
  if (typeof value !== "string" || !value) return value;
  if (value === "~") return os.homedir();
  if (value.startsWith("~/") || value.startsWith("~\\")) {
    return path.join(os.homedir(), value.slice(2));
  }
  return value;
}

function readStartupConfigFile(file) {
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch (error) {
    if (error?.code === "ENOENT") return {};
    throw error;
  }
}

function writeStartupConfigFile(file, startupConfig) {
  const current = readStartupConfigFile(file);
  const next = {
    ...current,
    publicBaseUrl: startupConfig.publicBaseUrl,
    allowedRoots: [...startupConfig.allowedRoots],
    auxiliaryRoots: [...(startupConfig.auxiliaryRoots || [])],
    worktreeRoot: startupConfig.worktreeRoot,
    stateDir: startupConfig.stateDir,
    trustProxy: startupConfig.trustProxy,
  };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
}

function startupConfigFromEnvironment(env) {
  return {
    publicBaseUrl: env.DEVSPACE_PUBLIC_BASE_URL,
    allowedRoots: env.DEVSPACE_ALLOWED_ROOTS,
    auxiliaryRoots: env.WORKBRIDGE_AUXILIARY_ROOTS,
    worktreeRoot: env.DEVSPACE_WORKTREE_ROOT,
    stateDir: env.DEVSPACE_STATE_DIR,
    trustProxy: env.DEVSPACE_TRUST_PROXY,
  };
}

function normalizeStartupConfig(value, options = {}) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const publicBaseUrl = normalizePublicBaseUrl(source.publicBaseUrl);
  const allowedRoots = normalizeAllowedRoots(source.allowedRoots);
  const auxiliaryRoots = normalizeAllowedRoots(source.auxiliaryRoots, "Auxiliary Roots", true);
  const worktreeRoot = normalizePathValue(source.worktreeRoot);
  const stateDir = normalizePathValue(source.stateDir);
  const trustProxy = normalizeTrustProxy(source.trustProxy);
  const config = {
    ...(publicBaseUrl ? { publicBaseUrl } : {}),
    ...(allowedRoots ? { allowedRoots } : {}),
    ...(auxiliaryRoots !== undefined ? { auxiliaryRoots } : {}),
    ...(worktreeRoot ? { worktreeRoot } : {}),
    ...(stateDir ? { stateDir } : {}),
    ...(trustProxy !== undefined ? { trustProxy } : {}),
  };
  if (options.requireComplete && !startupConfigIsComplete(config)) {
    throw new Error("Startup Config requires Public Base URL, one or more Allowed Roots, State Directory, and Trust Proxy.");
  }
  return config;
}

function safeNormalizeStartupConfig(value) {
  try {
    return normalizeStartupConfig(value);
  } catch {
    return {};
  }
}

function normalizePublicBaseUrl(value) {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" || value.length > 2048) throw new Error("Invalid Public Base URL.");
  const parsed = new URL(value.trim());
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Public Base URL must use http or https.");
  }
  if (parsed.username || parsed.password) throw new Error("Public Base URL must not include credentials.");
  parsed.hash = "";
  parsed.search = "";
  parsed.pathname = parsed.pathname.replace(/\/+$/, "");
  return parsed.toString().replace(/\/$/, "");
}

function normalizeAllowedRoots(value, label = "Allowed Roots", allowEmpty = false) {
  if (value === undefined || value === null) return undefined;
  if (value === "" && allowEmpty) return [];
  if (value === "") return undefined;
  const roots = (Array.isArray(value) ? value : String(value).split(/[,\r\n]+/))
    .map((entry) => normalizePathValue(entry))
    .filter(Boolean);
  const unique = Array.from(new Set(roots));
  if ((!allowEmpty && unique.length === 0) || unique.length > 32) {
    throw new Error(`${label} must contain ${allowEmpty ? "0" : "1"} to 32 paths.`);
  }
  return unique;
}

function normalizePathValue(value) {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") throw new Error("Startup Config paths must be strings.");
  const normalized = value.trim();
  if (!normalized || normalized.length > 4096 || normalized.includes("\0")) {
    throw new Error("Invalid Startup Config path.");
  }
  return normalized;
}

function normalizeTrustProxy(value) {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["1", "true", "yes", "on"].includes(normalized)) return true;
    if (["0", "false", "no", "off"].includes(normalized)) return false;
  }
  throw new Error("Trust Proxy must be enabled or disabled.");
}

function mergeStartupConfigs(...values) {
  const merged = {};
  for (const value of values) {
    if (!value || typeof value !== "object") continue;
    for (const key of ["publicBaseUrl", "allowedRoots", "auxiliaryRoots", "worktreeRoot", "stateDir", "trustProxy"]) {
      if (value[key] !== undefined) merged[key] = Array.isArray(value[key]) ? [...value[key]] : value[key];
    }
  }
  return merged;
}

function startupConfigSourcesFor(value, source) {
  const sources = {};
  if (!value || typeof value !== "object") return sources;
  for (const key of ["publicBaseUrl", "allowedRoots", "auxiliaryRoots", "worktreeRoot", "stateDir", "trustProxy"]) {
    if (value[key] !== undefined) sources[key] = source;
  }
  return sources;
}

function mergeStartupConfigSources(...values) {
  return Object.assign({}, ...values.filter((value) => value && typeof value === "object"));
}

function normalizeStartupConfigSources(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const normalized = {};
  for (const key of ["publicBaseUrl", "allowedRoots", "auxiliaryRoots", "worktreeRoot", "stateDir", "trustProxy"]) {
    if (["environment", "config.json", "config.jsonc", "saved", "runtime"].includes(value[key])) normalized[key] = value[key];
  }
  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

function startupConfigIsComplete(value) {
  return typeof value?.publicBaseUrl === "string"
    && Array.isArray(value?.allowedRoots)
    && value.allowedRoots.length > 0
    && typeof value?.stateDir === "string"
    && typeof value?.trustProxy === "boolean";
}

function startupConfigsEqual(left, right) {
  if (!startupConfigIsComplete(left) || !startupConfigIsComplete(right)) return false;
  return left.publicBaseUrl === right.publicBaseUrl
    && startupPathsEqual(left.stateDir, right.stateDir)
    && left.trustProxy === right.trustProxy
    && left.allowedRoots.length === right.allowedRoots.length
    && left.allowedRoots.every((root, index) => startupPathsEqual(root, right.allowedRoots[index]))
    && startupPathArraysEqual(left.auxiliaryRoots, right.auxiliaryRoots)
    && startupPathsEqual(left.worktreeRoot, right.worktreeRoot);
}

function startupPathsEqual(left, right) {
  if (left === undefined || right === undefined) return left === right;
  return startupPathIdentity(left) === startupPathIdentity(right);
}

function startupPathArraysEqual(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right)) return left === right;
  return left.length === right.length
    && left.every((value, index) => startupPathsEqual(value, right[index]));
}

function startupPathIdentity(value) {
  const normalized = path.normalize(expandHome(normalizePathValue(value)));
  const root = path.parse(normalized).root;
  const trimmed = normalized.length > root.length
    ? normalized.replace(/[\\/]+$/, "")
    : normalized;
  return process.platform === "win32" ? trimmed.toLowerCase() : trimmed;
}

function startupConfigEnvironment(value) {
  return {
    ...(value?.publicBaseUrl ? { DEVSPACE_PUBLIC_BASE_URL: value.publicBaseUrl } : {}),
    ...(Array.isArray(value?.allowedRoots) && value.allowedRoots.length > 0
      ? { DEVSPACE_ALLOWED_ROOTS: value.allowedRoots.join(",") }
      : {}),
    ...(Array.isArray(value?.auxiliaryRoots)
      ? { WORKBRIDGE_AUXILIARY_ROOTS: value.auxiliaryRoots.join(",") }
      : {}),
    ...(value?.worktreeRoot ? { DEVSPACE_WORKTREE_ROOT: value.worktreeRoot } : {}),
    ...(value?.stateDir ? { DEVSPACE_STATE_DIR: value.stateDir } : {}),
    ...(typeof value?.trustProxy === "boolean"
      ? { DEVSPACE_TRUST_PROXY: value.trustProxy ? "1" : "0" }
      : {}),
  };
}

function monitorPortEnvironment(monitorUrl) {
  const parsed = new URL(monitorUrl);
  const port = parsed.port || (parsed.protocol === "https:" ? "443" : "80");
  return { WORKBRIDGE_MONITOR_PORT: port };
}

function cloneStartupConfig(value) {
  return mergeStartupConfigs(value);
}

module.exports = {
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
};
