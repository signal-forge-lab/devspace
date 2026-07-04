import { spawn } from "node:child_process";
import { getRuntimeInfo, type RuntimeInfo } from "./app-metadata.js";
import type { WorkflowMode } from "./workflow-tools.js";
import type { Workspace } from "./workspaces.js";

export const WORKBRIDGE_VERIFY_PROFILES = [
  "typecheck_only",
  "related_tests",
  "workflow_tools_test",
  "safe_editing_test",
  "npm_test",
  "build",
  "git_diff_check",
  "git_diff_cached_check",
  "git_status_check",
] as const;

export type WorkbridgeVerifyProfile = (typeof WORKBRIDGE_VERIFY_PROFILES)[number];

export interface WorkbridgeVerifyInput {
  workspace: Workspace;
  profile: WorkbridgeVerifyProfile;
  workflowMode?: WorkflowMode;
  timeoutMs?: number;
  maxOutputChars?: number;
  includeOutputOnSuccess?: boolean;
}

export interface WorkbridgeVerifyCommandResult extends Record<string, unknown> {
  label: string;
  bin: string;
  args: string[];
  status: "ok" | "failed" | "timed_out";
  exitCode?: number | string;
  signal?: string;
  durationMs: number;
  stdoutChars: number;
  stderrChars: number;
  stdoutTail?: string;
  stderrTail?: string;
  stdoutOmitted: boolean;
  stderrOmitted: boolean;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
}

export interface WorkbridgeVerifyResult extends Record<string, unknown> {
  status: "ok" | "failed" | "timed_out";
  profile: WorkbridgeVerifyProfile;
  workflowMode?: WorkflowMode;
  durationMs: number;
  commandCount: number;
  commands: WorkbridgeVerifyCommandResult[];
  summary: {
    failedCommands: number;
    timedOutCommands: number;
    stdoutChars: number;
    stderrChars: number;
    outputOmitted: boolean;
    outputTruncated: boolean;
  };
  runtimeInfo: RuntimeInfo;
  result: string;
}

interface FixedCommand {
  label: string;
  bin: string;
  args: string[];
  shell?: boolean;
}

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_OUTPUT_CHARS = 4_000;
const MAX_TIMEOUT_MS = 300_000;
const MAX_OUTPUT_CHARS = 50_000;
const TIMEOUT_KILL_GRACE_MS = 3_000;

export async function workbridgeVerify(input: WorkbridgeVerifyInput): Promise<WorkbridgeVerifyResult> {
  const timeoutMs = validateInteger("timeoutMs", input.timeoutMs ?? DEFAULT_TIMEOUT_MS, 1_000, MAX_TIMEOUT_MS);
  const maxOutputChars = validateInteger("maxOutputChars", input.maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS, 500, MAX_OUTPUT_CHARS);
  const startedAt = Date.now();
  const commands = commandsForProfile(input.profile);
  const results: WorkbridgeVerifyCommandResult[] = [];

  for (const command of commands) {
    const includeOutput = Boolean(input.includeOutputOnSuccess) || command.label === "git_status_check";
    const result = await runFixedCommand(input.workspace.root, command, timeoutMs, maxOutputChars, includeOutput);
    results.push(result);
    if (result.status !== "ok") break;
  }

  const failedCommands = results.filter((result) => result.status === "failed").length;
  const timedOutCommands = results.filter((result) => result.status === "timed_out").length;
  const stdoutChars = results.reduce((sum, result) => sum + result.stdoutChars, 0);
  const stderrChars = results.reduce((sum, result) => sum + result.stderrChars, 0);
  const outputOmitted = results.some((result) => result.stdoutOmitted || result.stderrOmitted);
  const outputTruncated = results.some((result) => result.stdoutTruncated || result.stderrTruncated);
  const status: WorkbridgeVerifyResult["status"] = timedOutCommands > 0 ? "timed_out" : failedCommands > 0 ? "failed" : "ok";
  const durationMs = Date.now() - startedAt;
  const resultText = `workbridge_verify ${input.profile}: ${status} in ${durationMs}ms (${results.length}/${commands.length} commands)`;

  return {
    status,
    profile: input.profile,
    workflowMode: input.workflowMode,
    durationMs,
    commandCount: commands.length,
    commands: results,
    summary: { failedCommands, timedOutCommands, stdoutChars, stderrChars, outputOmitted, outputTruncated },
    runtimeInfo: getRuntimeInfo(),
    result: resultText,
  };
}

function commandsForProfile(profile: WorkbridgeVerifyProfile): FixedCommand[] {
  const usePackageManagerShell = process.platform === "win32";
  const npm = "npm";
  const npx = "npx";
  const packageManager = (label: string, bin: string, args: string[]): FixedCommand => ({ label, bin, args, shell: usePackageManagerShell });
  switch (profile) {
    case "typecheck_only":
      return [packageManager("typecheck", npm, ["run", "typecheck"])];
    case "workflow_tools_test":
      return [packageManager("workflow_tools_test", npx, ["tsx", "src/workflow-tools.test.ts"])];
    case "safe_editing_test":
      return [packageManager("safe_editing_test", npx, ["tsx", "src/safe-editing.test.ts"])];
    case "related_tests":
      return [
        packageManager("workflow_tools_test", npx, ["tsx", "src/workflow-tools.test.ts"]),
        packageManager("safe_editing_test", npx, ["tsx", "src/safe-editing.test.ts"]),
      ];
    case "npm_test":
      return [packageManager("npm_test", npm, ["test"])];
    case "build":
      return [packageManager("build", npm, ["run", "build"])];
    case "git_diff_check":
      return [{ label: "git_diff_check", bin: "git", args: ["diff", "--check"] }];
    case "git_diff_cached_check":
      return [{ label: "git_diff_cached_check", bin: "git", args: ["diff", "--cached", "--check"] }];
    case "git_status_check":
      return [{ label: "git_status_check", bin: "git", args: ["status", "--short"] }];
    default: {
      const neverProfile: never = profile;
      throw new Error(`Unsupported verify profile: ${neverProfile}`);
    }
  }
}

function runFixedCommand(cwd: string, command: FixedCommand, timeoutMs: number, maxOutputChars: number, includeOutputOnSuccess: boolean): Promise<WorkbridgeVerifyCommandResult> {
  const startedAt = Date.now();
  const tailChars = Math.max(1, Math.floor(maxOutputChars / 2));
  const stdout = new TailCapture(tailChars);
  const stderr = new TailCapture(tailChars);
  let timedOut = false;

  return new Promise((resolve) => {
    let child;
    try {
      const spawnSpec = spawnSpecForCommand(command);
      child = spawn(spawnSpec.bin, spawnSpec.args, { cwd, shell: spawnSpec.shell, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      stderr.push(error instanceof Error ? error.message : String(error));
      resolve(commandResult(command, "failed", Date.now() - startedAt, stdout, stderr, true, undefined, undefined));
      return;
    }
    let settled = false;
    let killTimer: NodeJS.Timeout | undefined;

    const finish = (
      status: WorkbridgeVerifyCommandResult["status"],
      includeOutput: boolean,
      exitCode?: number | string | null,
      signal?: string | null,
    ) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (killTimer) clearTimeout(killTimer);
      resolve(commandResult(command, status, Date.now() - startedAt, stdout, stderr, includeOutput, exitCode, signal));
    };

    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      killTimer = setTimeout(() => {
        if (!settled) child.kill("SIGKILL");
      }, TIMEOUT_KILL_GRACE_MS);
    }, timeoutMs);

    child.stdout?.on("data", (chunk: Buffer | string) => stdout.push(chunk));
    child.stderr?.on("data", (chunk: Buffer | string) => stderr.push(chunk));

    child.on("error", (error) => {
      stderr.push(error instanceof Error ? error.message : String(error));
      finish("failed", true, undefined, undefined);
    });

    child.on("close", (code, signal) => {
      const status: WorkbridgeVerifyCommandResult["status"] = timedOut ? "timed_out" : code === 0 ? "ok" : "failed";
      finish(status, includeOutputOnSuccess || status !== "ok", code, signal);
    });
  });
}

function spawnSpecForCommand(command: FixedCommand): { bin: string; args: string[]; shell: boolean } {
  if (command.shell !== true) return { bin: command.bin, args: command.args, shell: false };
  return { bin: [command.bin, ...command.args].map(shellQuote).join(" "), args: [], shell: true };
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:=@-]+$/.test(value)) return value;
  return `"${value.replaceAll('"', '\"')}"`;
}

function commandResult(command: FixedCommand, status: WorkbridgeVerifyCommandResult["status"], durationMs: number, stdout: TailCapture, stderr: TailCapture, includeOutput: boolean, exitCode?: number | string | null, signal?: string | null): WorkbridgeVerifyCommandResult {
  const includeStdout = includeOutput && stdout.chars > 0;
  const includeStderr = stderr.chars > 0 && (includeOutput || status === "ok");
  return {
    label: command.label,
    bin: command.bin,
    args: command.args,
    status,
    exitCode: exitCode ?? undefined,
    signal: signal ?? undefined,
    durationMs,
    stdoutChars: stdout.chars,
    stderrChars: stderr.chars,
    stdoutTail: includeStdout ? stdout.tail : undefined,
    stderrTail: includeStderr ? stderr.tail : undefined,
    stdoutOmitted: stdout.chars > 0 && !includeStdout,
    stderrOmitted: stderr.chars > 0 && !includeStderr,
    stdoutTruncated: includeStdout && stdout.truncated,
    stderrTruncated: includeStderr && stderr.truncated,
  };
}

class TailCapture {
  private value = "";
  public chars = 0;

  public constructor(private readonly maxChars: number) {}

  public push(chunk: Buffer | string): void {
    const text = chunk.toString();
    this.chars += text.length;
    this.value += text;
    if (this.value.length > this.maxChars) {
      this.value = this.value.slice(this.value.length - this.maxChars);
    }
  }

  public get tail(): string {
    return this.value;
  }

  public get truncated(): boolean {
    return this.chars > this.value.length;
  }
}

function validateInteger(name: string, value: number, min: number, max: number): number {
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${name} must be an integer between ${min} and ${max}.`);
  return value;
}
