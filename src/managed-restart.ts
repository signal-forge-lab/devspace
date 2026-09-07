import { spawn, type SpawnOptions } from "node:child_process";
import { existsSync } from "node:fs";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, extname, join, posix, resolve, win32 } from "node:path";
import { expandHomePath } from "./roots.js";

const DEFAULT_MONITOR_PORT = 7677;
const DEFAULT_STARTUP_DELAY_MS = 2_000;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 15_000;
const DEFAULT_STARTUP_TIMEOUT_MS = 20_000;
const DEFAULT_POLL_INTERVAL_MS = 250;
const MAX_STATE_FILE_CHARACTERS = 128 * 1024;

export interface ManagedRestartState {
  controlToken: string;
  startupConfig: {
    publicBaseUrl: string;
    allowedRoots: string[];
    auxiliaryRoots?: string[];
    worktreeRoot?: string;
    stateDir: string;
    trustProxy: boolean;
  };
  startupConfigSources?: Partial<Record<
    "publicBaseUrl" | "allowedRoots" | "auxiliaryRoots" | "worktreeRoot" | "stateDir" | "trustProxy",
    "environment" | "config.json" | "config.jsonc" | "saved" | "runtime"
  >>;
}

export interface ManagedRestartWorkerOptions {
  stateFile: string;
  monitorUrl: string;
  serverCliPath: string;
  expectedVersion: string;
}

interface SpawnedProcess {
  pid?: number;
  unref?(): void;
}

export interface ManagedRestartWorkerRuntime {
  requestShutdown(url: string, token: string): Promise<boolean>;
  readVersion(url: string): Promise<string | undefined>;
  spawnServer(input: {
    command: string;
    args: string[];
    cwd: string;
    env: NodeJS.ProcessEnv;
  }): number | undefined;
  sleep(milliseconds: number): Promise<void>;
  appendLog(path: string, event: string, fields?: Record<string, unknown>): Promise<void>;
  requestMonitorRelaunch(path: string): Promise<void>;
}

export interface ManagedRestartScheduleRuntime {
  spawnHelper(command: string, args: readonly string[], options: SpawnOptions): SpawnedProcess;
}

export interface ManagedRestartScheduleOptions {
  currentCliPath: string;
  expectedVersion: string;
  stateFile?: string;
  monitorUrl?: string;
  serverCliPath?: string;
  environment?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
}

export function resolveManagedRestartStatePath(
  environment: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  const override = environment.WORKBRIDGE_SUPERVISOR_STATE_FILE?.trim();
  if (override) return override;

  if (platform === "win32") {
    const appData = environment.APPDATA?.trim()
      || win32.join(environment.USERPROFILE?.trim() || homedir(), "AppData", "Roaming");
    return win32.join(
      appData,
      "@workbridge",
      "session-monitor-desktop",
      "supervisor-state.json",
    );
  }

  const home = environment.HOME?.trim() || homedir();
  const appData = platform === "darwin"
    ? posix.join(home, "Library", "Application Support")
    : environment.XDG_CONFIG_HOME?.trim() || posix.join(home, ".config");
  return posix.join(
    appData,
    "@workbridge",
    "session-monitor-desktop",
    "supervisor-state.json",
  );
}

export function resolveLocalMonitorUrl(
  environment: NodeJS.ProcessEnv = process.env,
): string {
  const configured = environment.WORKBRIDGE_MONITOR_URL?.trim();
  const port = environment.WORKBRIDGE_MONITOR_PORT?.trim() || String(DEFAULT_MONITOR_PORT);
  const parsedPort = Number(port);
  if (!Number.isInteger(parsedPort) || parsedPort < 1 || parsedPort > 65_535) {
    throw new Error("WORKBRIDGE_MONITOR_PORT must be an integer between 1 and 65535.");
  }

  const url = new URL(configured || `http://127.0.0.1:${parsedPort}`);
  const hostname = url.hostname.toLowerCase();
  if (url.protocol !== "http:") {
    throw new Error("Managed restart requires the local HTTP Session Monitor.");
  }
  if (!["127.0.0.1", "localhost", "::1", "[::1]"].includes(hostname)) {
    throw new Error("Managed restart monitor URL must use a loopback host.");
  }
  if (url.username || url.password) {
    throw new Error("Managed restart monitor URL must not include credentials.");
  }
  return url.origin;
}

export async function readManagedRestartState(path: string): Promise<ManagedRestartState> {
  const text = await readFile(path, "utf8");
  if (text.length > MAX_STATE_FILE_CHARACTERS) {
    throw new Error("Workbridge Monitor supervisor state is unexpectedly large.");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("Workbridge Monitor supervisor state is not valid JSON.");
  }
  const state = objectRecord(parsed, "Workbridge Monitor supervisor state");
  const startup = objectRecord(state.startupConfig, "Workbridge Monitor startupConfig");
  const controlToken = requiredString(state.controlToken, "Workbridge Monitor controlToken", 4_096);
  const publicBaseUrl = requiredPublicUrl(startup.publicBaseUrl);
  const allowedRoots = requiredStringArray(startup.allowedRoots, "Workbridge Monitor allowedRoots", 32);
  const auxiliaryRoots = optionalStringArray(
    startup.auxiliaryRoots,
    "Workbridge Monitor auxiliaryRoots",
    32,
  );
  const worktreeRoot = optionalString(startup.worktreeRoot, "Workbridge Monitor worktreeRoot", 4_096);
  const stateDir = requiredString(startup.stateDir, "Workbridge Monitor stateDir", 4_096);
  if (typeof startup.trustProxy !== "boolean") {
    throw new Error("Workbridge Monitor trustProxy must be a boolean.");
  }

  const startupConfigSources = optionalStartupConfigSources(state.startupConfigSources);

  return {
    controlToken,
    startupConfig: {
      publicBaseUrl,
      allowedRoots,
      ...(auxiliaryRoots !== undefined ? { auxiliaryRoots } : {}),
      ...(worktreeRoot ? { worktreeRoot } : {}),
      stateDir,
      trustProxy: startup.trustProxy,
    },
    ...(startupConfigSources ? { startupConfigSources } : {}),
  };
}

export async function scheduleManagedRestart(
  options: ManagedRestartScheduleOptions,
  runtime: ManagedRestartScheduleRuntime = defaultScheduleRuntime,
): Promise<{
  pid?: number;
  logFile: string;
}> {
  const environment = options.environment ?? process.env;
  const stateFile = options.stateFile
    ?? resolveManagedRestartStatePath(environment, options.platform ?? process.platform);
  const state = await readManagedRestartState(stateFile);
  const monitorUrl = options.monitorUrl
    ? resolveLocalMonitorUrl({ WORKBRIDGE_MONITOR_URL: options.monitorUrl })
    : resolveLocalMonitorUrl(environment);
  const serverCliPath = resolveServerCliPath(options.currentCliPath, options.serverCliPath);
  const helperArguments = cliNodeArguments(options.currentCliPath, [
    "__managed-restart-worker",
    "--state-file", stateFile,
    "--monitor-url", monitorUrl,
    "--server-cli", serverCliPath,
    "--expected-version", requiredString(options.expectedVersion, "expected version", 128),
  ]);
  const child = runtime.spawnHelper(process.execPath, helperArguments, {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.unref?.();
  return {
    pid: child.pid,
    logFile: managedRestartLogFile(state),
  };
}

export function parseManagedRestartWorkerArgs(args: readonly string[]): ManagedRestartWorkerOptions {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    const value = args[index + 1];
    if (!name || !value || !name.startsWith("--")) {
      throw new Error("Invalid managed restart worker arguments.");
    }
    if (!["--state-file", "--monitor-url", "--server-cli", "--expected-version"].includes(name)) {
      throw new Error(`Unsupported managed restart worker argument: ${name}.`);
    }
    if (values.has(name)) throw new Error(`Duplicate managed restart worker argument: ${name}.`);
    values.set(name, value);
  }

  return {
    stateFile: requiredString(values.get("--state-file"), "managed restart state file", 4_096),
    monitorUrl: resolveLocalMonitorUrl({
      WORKBRIDGE_MONITOR_URL: requiredString(
        values.get("--monitor-url"),
        "managed restart monitor URL",
        2_048,
      ),
    }),
    serverCliPath: requiredString(values.get("--server-cli"), "managed restart server CLI", 4_096),
    expectedVersion: requiredString(
      values.get("--expected-version"),
      "managed restart expected version",
      128,
    ),
  };
}

export async function runManagedRestartWorker(
  options: ManagedRestartWorkerOptions,
  runtime: ManagedRestartWorkerRuntime = defaultWorkerRuntime,
): Promise<void> {
  const state = await readManagedRestartState(options.stateFile);
  const monitorUrl = resolveLocalMonitorUrl({ WORKBRIDGE_MONITOR_URL: options.monitorUrl });
  const logFile = managedRestartLogFile(state);
  const fields = { expectedVersion: options.expectedVersion, monitorUrl };

  try {
    await runtime.appendLog(logFile, "managed_restart_started", fields);
    await runtime.sleep(DEFAULT_STARTUP_DELAY_MS);

    const accepted = await runtime.requestShutdown(
      new URL("/monitor/api/control/shutdown", monitorUrl).toString(),
      state.controlToken,
    );
    if (!accepted) throw new Error("Workbridge shutdown request was rejected.");
    await runtime.appendLog(logFile, "managed_restart_shutdown_accepted", fields);

    await waitFor(
      async () => await runtime.readVersion(
        new URL("/monitor/api/status", monitorUrl).toString(),
      ) === undefined,
      DEFAULT_SHUTDOWN_TIMEOUT_MS,
      DEFAULT_POLL_INTERVAL_MS,
      runtime.sleep,
      "Timed out waiting for Workbridge shutdown.",
    );

    const serverCliPath = resolve(options.serverCliPath);
    const pid = runtime.spawnServer({
      command: process.execPath,
      args: cliNodeArguments(serverCliPath, ["serve"]),
      cwd: resolve(dirname(serverCliPath), ".."),
      env: managedRestartEnvironment(state, monitorUrl),
    });
    await runtime.appendLog(logFile, "managed_restart_server_spawned", {
      ...fields,
      ...(pid === undefined ? {} : { pid }),
    });

    await waitFor(
      async () => await runtime.readVersion(
        new URL("/monitor/api/status", monitorUrl).toString(),
      ) === options.expectedVersion,
      DEFAULT_STARTUP_TIMEOUT_MS,
      DEFAULT_POLL_INTERVAL_MS,
      runtime.sleep,
      `Timed out waiting for Workbridge ${options.expectedVersion} startup.`,
    );
    await runtime.requestMonitorRelaunch(resolveMonitorRelaunchRequestPath(options.stateFile));
    await runtime.appendLog(logFile, "managed_restart_monitor_relaunch_requested", fields);
    await runtime.appendLog(logFile, "managed_restart_completed", {
      ...fields,
      ...(pid === undefined ? {} : { pid }),
    });
  } catch (error) {
    await runtime.appendLog(logFile, "managed_restart_failed", {
      ...fields,
      error: error instanceof Error ? error.message : String(error),
    }).catch(() => undefined);
    throw error;
  }
}

export function resolveMonitorRelaunchRequestPath(stateFile: string): string {
  return join(dirname(stateFile), "monitor-relaunch-request.json");
}

function resolveServerCliPath(currentCliPath: string, requested: string | undefined): string {
  if (requested) return resolve(requested);
  const packageRoot = resolve(dirname(currentCliPath), "..");
  const builtCli = join(packageRoot, "dist", "cli.js");
  if (!existsSync(builtCli)) {
    throw new Error("Managed restart requires a built dist/cli.js. Run npm run build first.");
  }
  return builtCli;
}

function managedRestartEnvironment(
  state: ManagedRestartState,
  monitorUrl: string,
): NodeJS.ProcessEnv {
  const parsedMonitorUrl = new URL(monitorUrl);
  const legacyAllOverrides = state.startupConfigSources === undefined;
  const isOverride = (key: keyof NonNullable<ManagedRestartState["startupConfigSources"]>) => (
    legacyAllOverrides || state.startupConfigSources?.[key] === "environment"
  );
  const environment: NodeJS.ProcessEnv = { ...process.env };
  for (const name of [
    "DEVSPACE_PUBLIC_BASE_URL",
    "DEVSPACE_ALLOWED_ROOTS",
    "WORKBRIDGE_AUXILIARY_ROOTS",
    "DEVSPACE_WORKTREE_ROOT",
    "DEVSPACE_STATE_DIR",
    "DEVSPACE_TRUST_PROXY",
  ]) {
    delete environment[name];
  }
  return {
    ...environment,
    ...(isOverride("publicBaseUrl")
      ? { DEVSPACE_PUBLIC_BASE_URL: state.startupConfig.publicBaseUrl }
      : {}),
    ...(isOverride("allowedRoots")
      ? { DEVSPACE_ALLOWED_ROOTS: state.startupConfig.allowedRoots.join(",") }
      : {}),
    ...(isOverride("auxiliaryRoots") && state.startupConfig.auxiliaryRoots !== undefined
      ? { WORKBRIDGE_AUXILIARY_ROOTS: state.startupConfig.auxiliaryRoots.join(",") }
      : {}),
    ...(isOverride("worktreeRoot") && state.startupConfig.worktreeRoot
      ? { DEVSPACE_WORKTREE_ROOT: state.startupConfig.worktreeRoot }
      : {}),
    ...(isOverride("stateDir")
      ? { DEVSPACE_STATE_DIR: state.startupConfig.stateDir }
      : {}),
    ...(isOverride("trustProxy")
      ? { DEVSPACE_TRUST_PROXY: state.startupConfig.trustProxy ? "1" : "0" }
      : {}),
    WORKBRIDGE_MONITOR_PORT: parsedMonitorUrl.port || String(DEFAULT_MONITOR_PORT),
    WORKBRIDGE_MONITOR_CONTROL_TOKEN: state.controlToken,
  };
}

function optionalStartupConfigSources(
  value: unknown,
): ManagedRestartState["startupConfigSources"] | undefined {
  if (value === undefined) return undefined;
  const record = objectRecord(value, "Workbridge Monitor startupConfigSources");
  const result: NonNullable<ManagedRestartState["startupConfigSources"]> = {};
  const allowed = new Set(["environment", "config.json", "config.jsonc", "saved", "runtime"]);
  for (const key of [
    "publicBaseUrl",
    "allowedRoots",
    "auxiliaryRoots",
    "worktreeRoot",
    "stateDir",
    "trustProxy",
  ] as const) {
    const source = record[key];
    if (source === undefined) continue;
    if (typeof source !== "string" || !allowed.has(source)) {
      throw new Error(`Workbridge Monitor startupConfigSources.${key} is invalid.`);
    }
    result[key] = source as NonNullable<ManagedRestartState["startupConfigSources"]>[typeof key];
  }
  return result;
}

function managedRestartLogFile(state: ManagedRestartState): string {
  return join(expandHomePath(state.startupConfig.stateDir), "managed-restart.jsonl");
}

function cliNodeArguments(cliPath: string, args: readonly string[]): string[] {
  return extname(cliPath).toLowerCase() === ".ts"
    ? ["--import", "tsx", cliPath, ...args]
    : [cliPath, ...args];
}

async function waitFor(
  check: () => Promise<boolean>,
  timeoutMs: number,
  pollIntervalMs: number,
  sleep: (milliseconds: number) => Promise<void>,
  timeoutMessage: string,
): Promise<void> {
  const attempts = Math.max(1, Math.ceil(timeoutMs / pollIntervalMs));
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (await check()) return;
    if (attempt + 1 < attempts) await sleep(pollIntervalMs);
  }
  throw new Error(timeoutMessage);
}

function objectRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} must be a non-empty string.`);
  }
  const trimmed = value.trim();
  if (trimmed.length > maximum || /[\u0000\r\n]/.test(trimmed)) {
    throw new Error(`${label} is invalid.`);
  }
  return trimmed;
}

function requiredStringArray(value: unknown, label: string, maximum: number): string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > maximum) {
    throw new Error(`${label} must contain 1 to ${maximum} paths.`);
  }
  return value.map((entry, index) => requiredString(entry, `${label}[${index}]`, 4_096));
}

function optionalString(value: unknown, label: string, maximum: number): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  return requiredString(value, label, maximum);
}

function optionalStringArray(value: unknown, label: string, maximum: number): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.length > maximum) {
    throw new Error(`${label} must contain 0 to ${maximum} paths.`);
  }
  return value.map((entry, index) => requiredString(entry, `${label}[${index}]`, 4_096));
}

function requiredPublicUrl(value: unknown): string {
  const text = requiredString(value, "Workbridge Monitor publicBaseUrl", 2_048);
  const url = new URL(text);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
    throw new Error("Workbridge Monitor publicBaseUrl is invalid.");
  }
  return text;
}

const defaultScheduleRuntime: ManagedRestartScheduleRuntime = {
  spawnHelper: (command, args, options) => spawn(command, [...args], options),
};

const defaultWorkerRuntime: ManagedRestartWorkerRuntime = {
  requestShutdown: async (url, token) => {
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          accept: "application/json",
          authorization: `Bearer ${token}`,
          "user-agent": "Workbridge-Managed-Restart",
        },
        signal: AbortSignal.timeout(3_000),
      });
      return response.status === 202;
    } catch {
      return false;
    }
  },
  readVersion: async (url) => {
    try {
      const response = await fetch(url, {
        headers: {
          accept: "application/json",
          "user-agent": "Workbridge-Managed-Restart",
        },
        signal: AbortSignal.timeout(1_000),
      });
      if (!response.ok) return undefined;
      const value: unknown = await response.json();
      if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
      const server = (value as Record<string, unknown>).server;
      if (!server || typeof server !== "object" || Array.isArray(server)) return undefined;
      const version = (server as Record<string, unknown>).version;
      return typeof version === "string" ? version : undefined;
    } catch {
      return undefined;
    }
  },
  spawnServer: (input) => {
    const child = spawn(input.command, input.args, {
      cwd: input.cwd,
      env: input.env,
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.unref();
    return child.pid;
  },
  sleep: (milliseconds) => new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds)),
  appendLog: async (path, event, fields = {}) => {
    await mkdir(dirname(path), { recursive: true });
    await appendFile(path, `${JSON.stringify({
      ts: new Date().toISOString(),
      event,
      ...fields,
    })}\n`, "utf8");
  },
  requestMonitorRelaunch: async (path) => {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify({
      version: 1,
      requestedAt: new Date().toISOString(),
    }), "utf8");
  },
};
