import { spawn, type SpawnOptions } from "node:child_process";
import { createHash } from "node:crypto";
import { stat } from "node:fs/promises";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, extname, isAbsolute, join, resolve } from "node:path";
import { isPathInsideRoot, resolveAllowedRealPath } from "./roots.js";
import {
  resolveWorkspaceAction,
  type ResolvedWorkspaceAction,
  type ResolveWorkspaceActionInput,
} from "./workspace-actions.js";
import { pendingWorkspaceActionSteps } from "./workspace-action-plans.js";
import {
  runWorkspaceActionProcessPlan,
  type WorkspaceActionProcessContext,
} from "./workspace-action-process-runner.js";
import {
  scheduleWindowsLocalActionTrigger,
  type WindowsLocalActionTriggerScheduleInput,
} from "./local-action-trigger-windows.js";

export const LOCAL_ACTION_TRIGGER_SCHEMA_VERSION = "workbridge_local_action_trigger_v1";
const LOCAL_ACTION_TRIGGER_EVIDENCE_SCHEMA_VERSION = "workbridge_local_action_trigger_evidence_v1";
const MAX_MANIFEST_BYTES = 64 * 1024;
const MAX_TRIGGER_ID_CHARACTERS = 128;
const MAX_SCHEDULE_WINDOW_MS = 24 * 60 * 60 * 1_000;
const MAX_SLEEP_SLICE_MS = 60_000;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const TRIGGER_ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;
const UTC_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const MANIFEST_KEYS = new Set([
  "schemaVersion",
  "triggerId",
  "action",
  "preset",
  "workspaceRoot",
  "allowedRootsSha256",
  "parameters",
  "expectedResolvedCommandSha256",
  "fireAtUtc",
  "expiresAtUtc",
  "evidencePath",
]);

export interface LocalActionTriggerConfig {
  allowedRoots: string[];
  stateDir: string;
}

export interface LocalActionTriggerManifest {
  schemaVersion: typeof LOCAL_ACTION_TRIGGER_SCHEMA_VERSION;
  triggerId: string;
  action: "ao_registered_python";
  preset: "help" | "execute" | "freeze_first_execute";
  workspaceRoot: string;
  allowedRootsSha256: string;
  parameters: Record<string, unknown>;
  expectedResolvedCommandSha256: string;
  fireAtUtc: string;
  expiresAtUtc: string;
  evidencePath: string;
}

export interface LoadedLocalActionTriggerManifest {
  manifestPath: string;
  manifestSha256: string;
  manifest: LocalActionTriggerManifest;
}

export interface LocalActionTriggerExecutionResult {
  processStartedCount: number;
  exitCode?: number;
  signal?: string;
  outputSha256: string;
  stdoutSha256: string;
  stderrSha256: string;
  outputCharacters: number;
  outputTruncated: boolean;
  steps: ReturnType<typeof pendingWorkspaceActionSteps>;
}

export interface LocalActionTriggerEvidence {
  schemaVersion: typeof LOCAL_ACTION_TRIGGER_EVIDENCE_SCHEMA_VERSION;
  status: "completed" | "failed" | "expired" | "manifest_mismatch" | "duplicate";
  triggerId: string;
  manifestPath: string;
  manifestSha256: string;
  action: string;
  preset: string;
  profile?: string;
  workspaceRoot: string;
  allowedRootsSha256: string;
  expectedResolvedCommandSha256: string;
  resolvedCommandSha256?: string;
  fireAtUtc: string;
  expiresAtUtc: string;
  claimedAtUtc?: string;
  startedAtUtc?: string;
  completedAtUtc: string;
  processStartedCount: number;
  exitCode?: number;
  signal?: string;
  outputSha256?: string;
  stdoutSha256?: string;
  stderrSha256?: string;
  outputCharacters?: number;
  outputTruncated?: boolean;
  steps: ReturnType<typeof pendingWorkspaceActionSteps>;
  claimPath: string;
  evidencePath: string;
  error?: string;
  hostIndependence: {
    detachedWorker: boolean;
    requiresMcpHostAtFireTime: false;
    serverOrDesktopRestartDependency: false;
    machineRestartPersistence: boolean;
  };
}

export type LocalActionTriggerLaunchMode = "detached_worker" | "windows_task_scheduler";

interface SpawnedProcess {
  pid?: number;
  unref?(): void;
}

export interface LocalActionTriggerArmRuntime {
  platform: NodeJS.Platform;
  spawnWorker(command: string, args: readonly string[], options: SpawnOptions): SpawnedProcess;
  scheduleWindowsWorker(input: WindowsLocalActionTriggerScheduleInput): Promise<{
    taskName: string;
    taskXmlPath: string;
    configSnapshotPath: string;
    configSnapshotSha256: string;
  }>;
}

export interface LocalActionTriggerWorkerRuntime {
  now(): Date;
  sleep(milliseconds: number): Promise<void>;
  resolveAction(input: ResolveWorkspaceActionInput): Promise<ResolvedWorkspaceAction>;
  executeAction(input: {
    resolved: ResolvedWorkspaceAction;
    workspaceRoot: string;
    triggerId: string;
  }): Promise<LocalActionTriggerExecutionResult>;
}

export function canonicalLocalActionTriggerManifest(value: unknown): {
  bytes: Buffer;
  sha256: string;
} {
  const bytes = Buffer.from(`${JSON.stringify(sortJsonValue(value), null, 2)}\n`, "utf8");
  return { bytes, sha256: sha256Bytes(bytes) };
}

export function allowedRootsIdentity(roots: readonly string[]): string {
  const normalized = Array.from(new Set(roots.map((root) => {
    const absolute = resolve(root);
    return process.platform === "win32" ? absolute.toLowerCase() : absolute;
  }))).sort();
  return sha256Text(JSON.stringify(normalized));
}

export async function loadLocalActionTriggerManifest(input: {
  manifestPath: string;
  expectedManifestSha256: string;
  config: LocalActionTriggerConfig;
}): Promise<LoadedLocalActionTriggerManifest> {
  requireSha256(input.expectedManifestSha256, "expected manifest SHA-256");
  const triggerRoot = await ensureTriggerRoot(input.config.stateDir);
  const manifestPath = await resolveAllowedRealPath(
    input.manifestPath,
    process.cwd(),
    [...input.config.allowedRoots, triggerRoot],
  );
  const details = await stat(manifestPath);
  if (!details.isFile() || details.size <= 0 || details.size > MAX_MANIFEST_BYTES) {
    throw new Error("Local action trigger manifest must be a non-empty file within the size limit.");
  }
  const bytes = await readFile(manifestPath);
  const manifestSha256 = sha256Bytes(bytes);
  if (manifestSha256 !== input.expectedManifestSha256) {
    throw new Error("Local action trigger manifest SHA-256 mismatch.");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error("Local action trigger manifest is not valid UTF-8 JSON.");
  }
  const canonical = canonicalLocalActionTriggerManifest(parsed);
  if (!bytes.equals(canonical.bytes)) {
    throw new Error("Local action trigger manifest must use canonical JSON bytes.");
  }
  const manifest = validateManifest(parsed);
  if (manifest.allowedRootsSha256 !== allowedRootsIdentity(input.config.allowedRoots)) {
    throw new Error("Local action trigger allowed-root identity does not match current configuration.");
  }

  const workspaceRoot = await resolveAllowedRealPath(
    manifest.workspaceRoot,
    process.cwd(),
    input.config.allowedRoots,
  );
  const workspaceDetails = await stat(workspaceRoot);
  if (!workspaceDetails.isDirectory()) {
    throw new Error("Local action trigger workspaceRoot must identify a directory.");
  }
  manifest.workspaceRoot = workspaceRoot;

  const evidenceRoot = join(triggerRoot, "evidence");
  await mkdir(evidenceRoot, { recursive: true });
  const evidencePath = await resolveAllowedRealPath(
    manifest.evidencePath,
    evidenceRoot,
    [evidenceRoot],
  );
  if (!isPathInsideRoot(evidencePath, evidenceRoot) || extname(evidencePath).toLowerCase() !== ".json") {
    throw new Error("Local action trigger evidencePath must be a JSON file beneath the trigger evidence root.");
  }
  if (await pathExists(evidencePath)) {
    throw new Error("Local action trigger evidencePath already exists.");
  }
  manifest.evidencePath = evidencePath;

  return { manifestPath, manifestSha256, manifest };
}

export async function resolveLocalActionTrigger(input: {
  loaded: LoadedLocalActionTriggerManifest;
  config: LocalActionTriggerConfig;
  resolveAction?: LocalActionTriggerWorkerRuntime["resolveAction"];
}): Promise<{
  resolved: ResolvedWorkspaceAction;
  commandSha256: string;
}> {
  const resolver = input.resolveAction ?? resolveWorkspaceAction;
  const resolved = await resolver({
    workspaceRoot: input.loaded.manifest.workspaceRoot,
    action: input.loaded.manifest.action,
    preset: input.loaded.manifest.preset,
    parameters: input.loaded.manifest.parameters,
    allowedRoots: input.config.allowedRoots,
  });
  if (!resolved.plan) throw new Error("Local action trigger requires a process-backed action plan.");
  const commandSha256 = sha256Text(resolved.command);
  if (commandSha256 !== input.loaded.manifest.expectedResolvedCommandSha256) {
    throw new Error("Local action trigger resolved-command SHA-256 mismatch.");
  }
  return { resolved, commandSha256 };
}

export async function claimLocalActionTrigger(
  stateDir: string,
  triggerId: string,
  input: {
    manifestSha256: string;
    fireAtUtc: string;
    evidencePath: string;
    nowUtc: string;
    pid: number;
  },
): Promise<{ claimed: boolean; claimPath: string }> {
  requireTriggerId(triggerId);
  const triggerRoot = await ensureTriggerRoot(stateDir);
  const claimsRoot = join(triggerRoot, "claims");
  await mkdir(claimsRoot, { recursive: true });
  const claimPath = join(claimsRoot, `${triggerId}.json`);
  const claim = {
    schemaVersion: "workbridge_local_action_trigger_claim_v1",
    status: "armed",
    triggerId,
    manifestSha256: input.manifestSha256,
    fireAtUtc: input.fireAtUtc,
    evidencePath: input.evidencePath,
    claimedAtUtc: input.nowUtc,
    pid: input.pid,
  };
  try {
    await writeFile(claimPath, canonicalJsonBytes(claim), { flag: "wx" });
    return { claimed: true, claimPath };
  } catch (error) {
    if (isErrorCode(error, "EEXIST")) return { claimed: false, claimPath };
    throw error;
  }
}

export async function armLocalActionTrigger(
  input: {
    currentCliPath: string;
    manifestPath: string;
    expectedManifestSha256: string;
    config: LocalActionTriggerConfig;
  },
  runtime: LocalActionTriggerArmRuntime = defaultArmRuntime,
): Promise<{
  pid?: number;
  taskName?: string;
  taskXmlPath?: string;
  configSnapshotPath?: string;
  configSnapshotSha256?: string;
  triggerId: string;
  fireAtUtc: string;
  evidencePath: string;
  transport: LocalActionTriggerLaunchMode;
  machineRestartPersistence: boolean;
}> {
  const loaded = await loadLocalActionTriggerManifest(input);
  if (runtime.platform === "win32") {
    const workerArgs = cliNodeArguments(input.currentCliPath, [
      "__local-action-trigger-worker",
      "--manifest", loaded.manifestPath,
      "--manifest-sha256", loaded.manifestSha256,
      "--launch-mode", "windows_task_scheduler",
    ]);
    const scheduled = await runtime.scheduleWindowsWorker({
      stateDir: input.config.stateDir,
      allowedRoots: input.config.allowedRoots,
      triggerId: loaded.manifest.triggerId,
      fireAtUtc: loaded.manifest.fireAtUtc,
      expiresAtUtc: loaded.manifest.expiresAtUtc,
      workerCommand: process.execPath,
      workerArgs,
    });
    return {
      ...scheduled,
      triggerId: loaded.manifest.triggerId,
      fireAtUtc: loaded.manifest.fireAtUtc,
      evidencePath: loaded.manifest.evidencePath,
      transport: "windows_task_scheduler",
      machineRestartPersistence: true,
    };
  }
  const args = cliNodeArguments(input.currentCliPath, [
    "__local-action-trigger-worker",
    "--manifest", loaded.manifestPath,
    "--manifest-sha256", loaded.manifestSha256,
    "--launch-mode", "detached_worker",
  ]);
  const child = runtime.spawnWorker(process.execPath, args, {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.unref?.();
  return {
    pid: child.pid,
    triggerId: loaded.manifest.triggerId,
    fireAtUtc: loaded.manifest.fireAtUtc,
    evidencePath: loaded.manifest.evidencePath,
    transport: "detached_worker",
    machineRestartPersistence: false,
  };
}

export async function runLocalActionTriggerWorker(
  input: {
    manifestPath: string;
    expectedManifestSha256: string;
    config: LocalActionTriggerConfig;
    launchMode?: LocalActionTriggerLaunchMode;
  },
  runtime: LocalActionTriggerWorkerRuntime = defaultWorkerRuntime,
): Promise<LocalActionTriggerEvidence> {
  const loaded = await loadLocalActionTriggerManifest(input);
  const launchMode = input.launchMode ?? "detached_worker";
  const initialNow = runtime.now();
  const claim = await claimLocalActionTrigger(input.config.stateDir, loaded.manifest.triggerId, {
    manifestSha256: loaded.manifestSha256,
    fireAtUtc: loaded.manifest.fireAtUtc,
    evidencePath: loaded.manifest.evidencePath,
    nowUtc: initialNow.toISOString(),
    pid: process.pid,
  });
  if (!claim.claimed) {
    return baseEvidence(loaded, claim.claimPath, runtime.now(), "duplicate", {
      error: "Local action trigger was already armed or started.",
    }, launchMode);
  }

  const fireAt = parseUtcTimestamp(loaded.manifest.fireAtUtc, "fireAtUtc");
  const expiresAt = parseUtcTimestamp(loaded.manifest.expiresAtUtc, "expiresAtUtc");
  if (runtime.now().getTime() >= expiresAt.getTime()) {
    return await writeEvidence(loaded, baseEvidence(loaded, claim.claimPath, runtime.now(), "expired", {
      claimedAtUtc: initialNow.toISOString(),
      error: "Local action trigger expired before process start.",
    }, launchMode));
  }

  while (runtime.now().getTime() < fireAt.getTime()) {
    const remaining = fireAt.getTime() - runtime.now().getTime();
    await runtime.sleep(Math.min(remaining, MAX_SLEEP_SLICE_MS));
  }
  if (runtime.now().getTime() >= expiresAt.getTime()) {
    return await writeEvidence(loaded, baseEvidence(loaded, claim.claimPath, runtime.now(), "expired", {
      claimedAtUtc: initialNow.toISOString(),
      error: "Local action trigger expired before process start.",
    }, launchMode));
  }

  try {
    await loadLocalActionTriggerManifest(input);
  } catch (error) {
    return await writeEvidence(loaded, baseEvidence(loaded, claim.claimPath, runtime.now(), "manifest_mismatch", {
      claimedAtUtc: initialNow.toISOString(),
      error: error instanceof Error ? error.message : String(error),
    }, launchMode));
  }

  let resolution: Awaited<ReturnType<typeof resolveLocalActionTrigger>>;
  try {
    resolution = await resolveLocalActionTrigger({
      loaded,
      config: input.config,
      resolveAction: runtime.resolveAction,
    });
  } catch (error) {
    return await writeEvidence(loaded, baseEvidence(loaded, claim.claimPath, runtime.now(), "failed", {
      claimedAtUtc: initialNow.toISOString(),
      error: error instanceof Error ? error.message : String(error),
    }, launchMode));
  }

  const startedAtUtc = runtime.now().toISOString();
  let execution: LocalActionTriggerExecutionResult;
  try {
    execution = await runtime.executeAction({
      resolved: resolution.resolved,
      workspaceRoot: loaded.manifest.workspaceRoot,
      triggerId: loaded.manifest.triggerId,
    });
  } catch (error) {
    return await writeEvidence(loaded, baseEvidence(loaded, claim.claimPath, runtime.now(), "failed", {
      claimedAtUtc: initialNow.toISOString(),
      startedAtUtc,
      profile: resolution.resolved.profile,
      resolvedCommandSha256: resolution.commandSha256,
      error: error instanceof Error ? error.message : String(error),
    }, launchMode));
  }
  const expectedProcessStarts = resolution.resolved.plan?.steps.filter(
    (step) => step.kind === "process",
  ).length ?? 0;
  const status = execution.exitCode === 0
    && expectedProcessStarts > 0
    && execution.processStartedCount === expectedProcessStarts
    ? "completed"
    : "failed";
  return await writeEvidence(loaded, baseEvidence(loaded, claim.claimPath, runtime.now(), status, {
    claimedAtUtc: initialNow.toISOString(),
    startedAtUtc,
    profile: resolution.resolved.profile,
    resolvedCommandSha256: resolution.commandSha256,
    processStartedCount: execution.processStartedCount,
    exitCode: execution.exitCode,
    signal: execution.signal,
    outputSha256: execution.outputSha256,
    stdoutSha256: execution.stdoutSha256,
    stderrSha256: execution.stderrSha256,
    outputCharacters: execution.outputCharacters,
    outputTruncated: execution.outputTruncated,
    steps: execution.steps,
    ...(status === "failed" ? { error: "Local action trigger process did not complete successfully." } : {}),
  }, launchMode));
}

export function parseLocalActionTriggerCommandArgs(args: readonly string[]): {
  mode: "dry-run" | "arm";
  manifestPath: string;
  expectedManifestSha256: string;
} {
  const [mode, ...rest] = args;
  if (mode !== "dry-run" && mode !== "arm") {
    throw new Error("Usage: devspace action-trigger <dry-run|arm> --manifest <path> --manifest-sha256 <sha256>");
  }
  return { mode, ...parseManifestArguments(rest) };
}

export function parseLocalActionTriggerWorkerArgs(args: readonly string[]): {
  manifestPath: string;
  expectedManifestSha256: string;
  launchMode?: LocalActionTriggerLaunchMode;
  configSnapshotPath?: string;
  configSnapshotSha256?: string;
} {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    const value = args[index + 1];
    if (!name || !value || !name.startsWith("--")) {
      throw new Error("Invalid local action trigger worker arguments.");
    }
    if (!["--manifest", "--manifest-sha256", "--launch-mode", "--config-snapshot", "--config-snapshot-sha256"].includes(name)) {
      throw new Error(`Unsupported local action trigger worker argument: ${name}.`);
    }
    if (values.has(name)) throw new Error(`Duplicate local action trigger argument: ${name}.`);
    values.set(name, value);
  }
  const manifestPath = requiredAbsolutePath(values.get("--manifest"), "manifest path");
  const expectedManifestSha256 = requireSha256(values.get("--manifest-sha256"), "manifest SHA-256");
  const launchMode = values.get("--launch-mode");
  if (launchMode !== undefined && launchMode !== "detached_worker" && launchMode !== "windows_task_scheduler") {
    throw new Error("Local action trigger launch mode is not supported.");
  }
  const configSnapshotPath = values.get("--config-snapshot");
  const configSnapshotSha256 = values.get("--config-snapshot-sha256");
  if ((configSnapshotPath === undefined) !== (configSnapshotSha256 === undefined)) {
    throw new Error("Local action trigger config snapshot path and SHA-256 must be supplied together.");
  }
  if (launchMode === "windows_task_scheduler" && configSnapshotPath === undefined) {
    throw new Error("Windows Task Scheduler launch requires a config snapshot.");
  }
  if (configSnapshotPath !== undefined && launchMode !== "windows_task_scheduler") {
    throw new Error("Local action trigger config snapshots are restricted to Windows Task Scheduler launches.");
  }
  return {
    manifestPath,
    expectedManifestSha256,
    ...(launchMode ? { launchMode } : {}),
    ...(configSnapshotPath ? {
      configSnapshotPath: requiredAbsolutePath(configSnapshotPath, "config snapshot path"),
      configSnapshotSha256: requireSha256(configSnapshotSha256, "config snapshot SHA-256"),
    } : {}),
  };
}

async function executeResolvedAction(input: {
  resolved: ResolvedWorkspaceAction;
  workspaceRoot: string;
  triggerId: string;
}): Promise<LocalActionTriggerExecutionResult> {
  const plan = input.resolved.plan;
  if (!plan) throw new Error("Local action trigger requires a process-backed action plan.");
  const outputHash = createHash("sha256");
  const stdoutHash = createHash("sha256");
  const stderrHash = createHash("sha256");
  let outputCharacters = 0;
  let processStartedCount = 0;
  let exitCode: number | undefined;
  let signal: string | undefined;
  const context: WorkspaceActionProcessContext = {
    kind: "workspace_action",
    contractVersion: 2,
    action: input.resolved.action,
    preset: input.resolved.preset,
    profile: input.resolved.profile,
    policy: input.resolved.policy,
    commandPreview: input.resolved.displayCommand,
    profileEvidence: input.resolved.profileEvidence,
    warnings: input.resolved.warnings,
    artifacts: [],
    steps: pendingWorkspaceActionSteps(plan),
  };
  let finish: (() => void) | undefined;
  const completed = new Promise<void>((resolveCompleted) => {
    finish = resolveCompleted;
  });
  await runWorkspaceActionProcessPlan({
    workspaceId: `local-trigger:${input.triggerId}`,
    plan,
    plannedArtifacts: input.resolved.artifacts,
    cwd: input.workspaceRoot,
    workspaceRoot: input.workspaceRoot,
    tty: false,
    context,
  }, {
    isCancellationRequested: () => false,
    append: (text) => {
      outputHash.update(text, "utf8");
      outputCharacters += text.length;
    },
    appendStdout: (text) => stdoutHash.update(text, "utf8"),
    appendStderr: (text) => stderrHash.update(text, "utf8"),
    attachProcess: () => {
      processStartedCount += 1;
    },
    finish: (code, processSignal) => {
      exitCode = code;
      signal = processSignal;
      finish?.();
    },
  });
  await completed;
  return {
    processStartedCount,
    exitCode,
    signal,
    outputSha256: outputHash.digest("hex"),
    stdoutSha256: stdoutHash.digest("hex"),
    stderrSha256: stderrHash.digest("hex"),
    outputCharacters,
    outputTruncated: false,
    steps: context.steps,
  };
}

function validateManifest(value: unknown): LocalActionTriggerManifest {
  const record = objectRecord(value, "Local action trigger manifest");
  const unknown = Object.keys(record).filter((key) => !MANIFEST_KEYS.has(key));
  const missing = Array.from(MANIFEST_KEYS).filter((key) => !(key in record));
  if (unknown.length > 0) throw new Error(`Local action trigger manifest unknown fields: ${unknown.join(", ")}.`);
  if (missing.length > 0) throw new Error(`Local action trigger manifest missing fields: ${missing.join(", ")}.`);
  if (record.schemaVersion !== LOCAL_ACTION_TRIGGER_SCHEMA_VERSION) {
    throw new Error("Local action trigger manifest schemaVersion is not supported.");
  }
  const triggerId = requiredString(record.triggerId, "triggerId", MAX_TRIGGER_ID_CHARACTERS);
  requireTriggerId(triggerId);
  if (record.action !== "ao_registered_python") {
    throw new Error("Local action trigger action must be ao_registered_python.");
  }
  if (record.preset !== "help" && record.preset !== "execute" && record.preset !== "freeze_first_execute") {
    throw new Error("Local action trigger preset must be help, execute, or freeze_first_execute.");
  }
  const workspaceRoot = requiredAbsolutePath(record.workspaceRoot, "workspaceRoot");
  const allowedRootsSha256 = requireSha256(record.allowedRootsSha256, "allowedRootsSha256");
  const parameters = objectRecord(record.parameters, "parameters");
  const expectedResolvedCommandSha256 = requireSha256(
    record.expectedResolvedCommandSha256,
    "expectedResolvedCommandSha256",
  );
  const fireAtUtc = requiredUtcTimestamp(record.fireAtUtc, "fireAtUtc");
  const expiresAtUtc = requiredUtcTimestamp(record.expiresAtUtc, "expiresAtUtc");
  const fireAt = parseUtcTimestamp(fireAtUtc, "fireAtUtc");
  const expiresAt = parseUtcTimestamp(expiresAtUtc, "expiresAtUtc");
  if (fireAt.getTime() >= expiresAt.getTime()) {
    throw new Error("Local action trigger fireAtUtc must precede expiresAtUtc.");
  }
  if (expiresAt.getTime() - fireAt.getTime() > MAX_SCHEDULE_WINDOW_MS) {
    throw new Error("Local action trigger expiry window exceeds 24 hours.");
  }
  const evidencePath = requiredAbsolutePath(record.evidencePath, "evidencePath");
  return {
    schemaVersion: LOCAL_ACTION_TRIGGER_SCHEMA_VERSION,
    triggerId,
    action: "ao_registered_python",
    preset: record.preset,
    workspaceRoot,
    allowedRootsSha256,
    parameters,
    expectedResolvedCommandSha256,
    fireAtUtc,
    expiresAtUtc,
    evidencePath,
  };
}

function baseEvidence(
  loaded: LoadedLocalActionTriggerManifest,
  claimPath: string,
  completedAt: Date,
  status: LocalActionTriggerEvidence["status"],
  extra: Partial<LocalActionTriggerEvidence>,
  launchMode: LocalActionTriggerLaunchMode = "detached_worker",
): LocalActionTriggerEvidence {
  return {
    schemaVersion: LOCAL_ACTION_TRIGGER_EVIDENCE_SCHEMA_VERSION,
    status,
    triggerId: loaded.manifest.triggerId,
    manifestPath: loaded.manifestPath,
    manifestSha256: loaded.manifestSha256,
    action: loaded.manifest.action,
    preset: loaded.manifest.preset,
    workspaceRoot: loaded.manifest.workspaceRoot,
    allowedRootsSha256: loaded.manifest.allowedRootsSha256,
    expectedResolvedCommandSha256: loaded.manifest.expectedResolvedCommandSha256,
    fireAtUtc: loaded.manifest.fireAtUtc,
    expiresAtUtc: loaded.manifest.expiresAtUtc,
    completedAtUtc: completedAt.toISOString(),
    processStartedCount: 0,
    steps: [],
    claimPath,
    evidencePath: loaded.manifest.evidencePath,
    hostIndependence: {
      detachedWorker: launchMode === "detached_worker",
      requiresMcpHostAtFireTime: false,
      serverOrDesktopRestartDependency: false,
      machineRestartPersistence: launchMode === "windows_task_scheduler",
    },
    ...extra,
  };
}

async function writeEvidence(
  loaded: LoadedLocalActionTriggerManifest,
  evidence: LocalActionTriggerEvidence,
): Promise<LocalActionTriggerEvidence> {
  await mkdir(dirname(loaded.manifest.evidencePath), { recursive: true });
  await writeFile(loaded.manifest.evidencePath, canonicalJsonBytes(evidence), { flag: "wx" });
  return evidence;
}

function parseManifestArguments(args: readonly string[]): {
  manifestPath: string;
  expectedManifestSha256: string;
} {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    const value = args[index + 1];
    if (!name || !value || !name.startsWith("--")) {
      throw new Error("Invalid local action trigger arguments.");
    }
    if (name !== "--manifest" && name !== "--manifest-sha256") {
      throw new Error(`Unsupported local action trigger argument: ${name}.`);
    }
    if (values.has(name)) throw new Error(`Duplicate local action trigger argument: ${name}.`);
    values.set(name, value);
  }
  const manifestPath = requiredAbsolutePath(values.get("--manifest"), "manifest path");
  const expectedManifestSha256 = requireSha256(
    values.get("--manifest-sha256"),
    "manifest SHA-256",
  );
  return { manifestPath, expectedManifestSha256 };
}

function canonicalJsonBytes(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(sortJsonValue(value), null, 2)}\n`, "utf8");
}

function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJsonValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, sortJsonValue(entry)]),
    );
  }
  return value;
}

function objectRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > maximum || value.includes("\0")) {
    throw new Error(`Local action trigger ${label} must be a non-empty bounded string.`);
  }
  return value;
}

function requiredAbsolutePath(value: unknown, label: string): string {
  const path = requiredString(value, label, 4_096);
  if (!isAbsolute(path)) throw new Error(`Local action trigger ${label} must be absolute.`);
  return resolve(path);
}

function requireTriggerId(value: string): void {
  if (value.length > MAX_TRIGGER_ID_CHARACTERS || !TRIGGER_ID_PATTERN.test(value)) {
    throw new Error("Local action trigger triggerId contains unsupported characters.");
  }
}

function requireSha256(value: unknown, label: string): string {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    throw new Error(`Local action trigger ${label} must be a lowercase SHA-256.`);
  }
  return value;
}

function requiredUtcTimestamp(value: unknown, label: string): string {
  if (typeof value !== "string" || !UTC_TIMESTAMP_PATTERN.test(value)) {
    throw new Error(`Local action trigger ${label} must use canonical UTC milliseconds.`);
  }
  const parsed = parseUtcTimestamp(value, label);
  if (parsed.toISOString() !== value) {
    throw new Error(`Local action trigger ${label} is not canonical UTC.`);
  }
  return value;
}

function parseUtcTimestamp(value: string, label: string): Date {
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) throw new Error(`Local action trigger ${label} is invalid.`);
  return new Date(milliseconds);
}

function sha256Bytes(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function sha256Text(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

async function ensureTriggerRoot(stateDir: string): Promise<string> {
  const root = resolve(stateDir, "local-action-triggers");
  await mkdir(root, { recursive: true });
  return root;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (isErrorCode(error, "ENOENT") || isErrorCode(error, "ENOTDIR")) return false;
    throw error;
  }
}

function isErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === code;
}

function cliNodeArguments(cliPath: string, args: readonly string[]): string[] {
  return extname(cliPath).toLowerCase() === ".ts"
    ? ["--import", "tsx", cliPath, ...args]
    : [cliPath, ...args];
}

const defaultArmRuntime: LocalActionTriggerArmRuntime = {
  platform: process.platform,
  spawnWorker: (command, args, options) => spawn(command, args, options),
  scheduleWindowsWorker: scheduleWindowsLocalActionTrigger,
};

const defaultWorkerRuntime: LocalActionTriggerWorkerRuntime = {
  now: () => new Date(),
  sleep: async (milliseconds) => await new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds)),
  resolveAction: resolveWorkspaceAction,
  executeAction: executeResolvedAction,
};
