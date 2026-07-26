"use strict";

const { spawn } = require("node:child_process");
const { randomUUID } = require("node:crypto");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const http = require("node:http");
const https = require("node:https");
const path = require("node:path");

const SUPPORTED_ACTIONS = new Set([
  "start",
  "stop",
  "restart",
  "build",
  "build-restart",
  "pause",
  "resume",
]);

class WorkbridgeSupervisor extends EventEmitter {
  constructor(options) {
    super();
    this.monitorUrl = options.monitorUrl;
    this.projectRoot = options.projectRoot;
    this.tokenFile = options.tokenFile;
    this.spawnProcess = options.spawnProcess || spawn;
    this.controlToken = readPersistedToken(this.tokenFile);
    this.runtimeStatus = undefined;
    this.serverReachable = false;
    this.managedChild = undefined;
    this.operation = undefined;
    this.lastResult = undefined;
    this.pollTimer = undefined;
  }

  beginPolling(intervalMs = 1000) {
    if (this.pollTimer) return;
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
    const runtimeStatus = await requestJson(runtimeStatusUrl(this.monitorUrl), { timeoutMs: 1000 });
    this.serverReachable = Boolean(runtimeStatus);
    this.runtimeStatus = runtimeStatus || undefined;
    this.emitStatus();
    return this.runtimeStatus;
  }

  status() {
    const runtimeServer = this.runtimeStatus?.server;
    const controllable = Boolean(
      this.serverReachable
      && runtimeServer?.controlEnabled
      && this.controlToken,
    );
    const ownership = this.serverReachable
      ? (controllable || this.managedChild ? "managed" : "external")
      : "none";
    let state = this.serverReachable ? "running" : "stopped";
    if (this.operation?.active) state = operationState(this.operation.action, this.operation.phase);
    else if (this.lastResult?.ok === false && !this.serverReachable) state = "error";

    return {
      version: 1,
      projectRoot: this.projectRoot,
      state,
      ownership,
      serverReachable: this.serverReachable,
      managedPid: this.managedChild?.pid,
      runtimeStatus: this.runtimeStatus,
      operation: this.operation,
      lastResult: this.lastResult,
      capabilities: {
        start: !this.serverReachable,
        stop: controllable || Boolean(this.managedChild),
        restart: controllable || Boolean(this.managedChild),
        build: true,
        buildRestart: !this.serverReachable || controllable || Boolean(this.managedChild),
        pause: true,
        resume: true,
      },
    };
  }

  async runAction(action) {
    if (!SUPPORTED_ACTIONS.has(action)) throw new Error(`Unsupported monitor action: ${action}`);
    if (this.operation?.active) throw new Error(`Another operation is already running: ${this.operation.action}`);
    this.operation = {
      active: true,
      action,
      phase: action,
      startedAt: Date.now(),
      line: "",
    };
    this.lastResult = undefined;
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
      throw error;
    } finally {
      this.operation = undefined;
      await this.refreshRuntimeStatus();
      this.emitStatus();
    }
  }

  async build() {
    this.setPhase("building", "Running npm run build…");
    const invocation = npmInvocation(["run", "build"]);
    await this.runCommand(invocation.command, invocation.args);
  }

  async startServer() {
    await this.refreshRuntimeStatus();
    if (this.serverReachable) throw new Error("Workbridge is already running.");
    this.setPhase("resuming", "Clearing soft pause before startup…");
    await this.runCliControl("resume");
    this.setPhase("starting", "Starting Workbridge…");

    this.controlToken = randomUUID();
    persistToken(this.tokenFile, this.controlToken);
    const child = this.spawnProcess(nodeCommand(), ["dist/cli.js", "serve"], {
      cwd: this.projectRoot,
      env: {
        ...process.env,
        WORKBRIDGE_MONITOR_CONTROL_TOKEN: this.controlToken,
      },
      windowsHide: true,
      detached: true,
      stdio: "ignore",
    });
    this.managedChild = child;
    child.unref?.();
    this.attachManagedChild(child);
    await waitFor(async () => Boolean(await requestJson(runtimeStatusUrl(this.monitorUrl), { timeoutMs: 700 })), 15_000);
    await this.refreshRuntimeStatus();
  }

  async stopServer() {
    await this.refreshRuntimeStatus();
    if (!this.serverReachable && !this.managedChild) return;
    if (!this.controlToken) throw new Error("This Workbridge process is external and cannot be stopped safely.");
    this.setPhase("stopping", "Stopping Workbridge…");
    const response = await requestJson(controlShutdownUrl(this.monitorUrl), {
      method: "POST",
      token: this.controlToken,
      timeoutMs: 1500,
      acceptStatuses: [202],
    });
    if (!response) {
      if (!this.managedChild) {
        throw new Error("The running Workbridge process is external or uses a different control token.");
      }
      this.managedChild.kill();
    }
    await waitFor(async () => !(await requestJson(runtimeStatusUrl(this.monitorUrl), { timeoutMs: 500 })), 10_000);
    this.serverReachable = false;
    this.runtimeStatus = undefined;
    this.managedChild = undefined;
  }

  async restartServer() {
    await this.refreshRuntimeStatus();
    if (this.serverReachable) await this.stopServer();
    await this.startServer();
  }

  async runCliControl(subcommand, extra = []) {
    this.setPhase(subcommand === "pause" ? "pausing" : "resuming", `Running control ${subcommand}…`);
    await this.runCommand(nodeCommand(), ["dist/cli.js", "control", subcommand, ...extra]);
  }

  runCommand(command, args) {
    return new Promise((resolve, reject) => {
      const child = this.spawnProcess(command, args, {
        cwd: this.projectRoot,
        env: process.env,
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

async function waitFor(check, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("Timed out waiting for the Workbridge process state to change.");
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

function npmInvocation(args) {
  if (process.platform === "win32") {
    return {
      command: process.env.ComSpec || "cmd.exe",
      args: ["/d", "/s", "/c", ["npm", ...args].join(" ")],
    };
  }
  return { command: "npm", args };
}

function readPersistedToken(file) {
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    return typeof value?.controlToken === "string" ? value.controlToken : undefined;
  } catch {
    return undefined;
  }
}

function persistToken(file, token) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ version: 1, controlToken: token }), "utf8");
}

module.exports = {
  SUPPORTED_ACTIONS,
  WorkbridgeSupervisor,
  controlShutdownUrl,
  isWorkbridgeRoot,
  npmInvocation,
  resolveWorkbridgeProjectRoot,
  runtimeStatusUrl,
};
