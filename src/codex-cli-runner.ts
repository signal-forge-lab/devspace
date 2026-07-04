import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { platform } from "node:os";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assertAllowedPath, expandHomePath } from "./roots.js";

export const CODEX_CLI_RUNNER_TOOL_NAME = "run_codex_cli";
export const CODEX_SANDBOX_VALUES = ["read-only", "workspace-write"] as const;
export const CODEX_RUNNER_MODE_VALUES = ["sync", "detached"] as const;
export const CODEX_RUNNER_SERVICE_TIER_VALUES = ["standard", "fast"] as const;
export const CODEX_RUNNER_REASONING_EFFORT_VALUES = ["minimal", "low", "medium", "high", "xhigh"] as const;
export const CODEX_RUNNER_STATUS_VALUES = [
  "completed",
  "failed",
  "limit_error",
  "early_error",
  "started_running",
  "launch_error",
  "timeout",
  "dry_run",
] as const;
export const CODEX_RUNNER_ERROR_KIND_VALUES = [
  "none",
  "codex_limit",
  "codex_failed",
  "python_not_found",
  "runner_validation_error",
  "timeout",
  "unknown",
] as const;
export const CODEX_RUNNER_NEXT_ACTION_VALUES = [
  "none",
  "continue_in_chatgpt",
] as const;
export type CodexSandbox = (typeof CODEX_SANDBOX_VALUES)[number];
export type CodexRunnerMode = (typeof CODEX_RUNNER_MODE_VALUES)[number];
export type CodexRunnerServiceTier = (typeof CODEX_RUNNER_SERVICE_TIER_VALUES)[number];
export type CodexRunnerReasoningEffort = (typeof CODEX_RUNNER_REASONING_EFFORT_VALUES)[number];
export type CodexRunnerStatus = (typeof CODEX_RUNNER_STATUS_VALUES)[number];
export type CodexRunnerErrorKind = (typeof CODEX_RUNNER_ERROR_KIND_VALUES)[number];
export type CodexRunnerNextAction = (typeof CODEX_RUNNER_NEXT_ACTION_VALUES)[number];

const DEFAULT_TIMEOUT_SECONDS = 900;
const MAX_TIMEOUT_SECONDS = 3600;
const DEFAULT_EARLY_WAIT_SECONDS = 10;
const MAX_EARLY_WAIT_SECONDS = 300;
const DEFAULT_MAX_OUTPUT_CHARACTERS = 80_000;
const DEFAULT_MAX_FALLBACK_PROMPT_CHARACTERS = 120_000;
const DEFAULT_CODEX_MODEL = "gpt-5.5";
const DEFAULT_CODEX_SERVICE_TIER: CodexRunnerServiceTier = "standard";
const DEFAULT_CODEX_REASONING_EFFORT: CodexRunnerReasoningEffort = "xhigh";

export interface RunCodexCliRunnerInput {
  projectDir: string;
  instructionFile: string;
  sandbox?: CodexSandbox;
  mode?: CodexRunnerMode;
  model?: string;
  serviceTier?: CodexRunnerServiceTier;
  reasoningEffort?: CodexRunnerReasoningEffort;
  dryRun?: boolean;
  json?: boolean;
  timeout?: number;
  earlyWaitSeconds?: number;
  maxOutputCharacters?: number;
  maxFallbackPromptCharacters?: number;
}

export interface RunCodexCliRunnerOptions {
  allowedRoots: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  pythonCommand?: string;
}

export interface ResolvedCodexCliRunnerRequest {
  projectDir: string;
  instructionFile: string;
  runnerPath: string;
  runnerDir: string;
  sandbox: CodexSandbox;
  mode: CodexRunnerMode;
  model: string;
  serviceTier: CodexRunnerServiceTier;
  reasoningEffort: CodexRunnerReasoningEffort;
  dryRun: boolean;
  json: boolean;
  timeoutSeconds: number;
  earlyWaitSeconds: number;
  maxOutputCharacters: number;
  maxFallbackPromptCharacters: number;
  pythonCommand: string;
  command: string[];
}

export interface CodexCliRunnerResult {
  result: string;
  status: CodexRunnerStatus;
  exitCode: number | null;
  timedOut: boolean;
  errorKind: CodexRunnerErrorKind;
  nextAction: CodexRunnerNextAction;
  fallbackRecommended: boolean;
  fallbackPrompt?: string;
  fallbackPromptSource?: string;
  fallbackPromptTruncated?: boolean;
  projectDir: string;
  instructionFile: string;
  runnerPath: string;
  sandbox: CodexSandbox;
  mode: CodexRunnerMode;
  model: string;
  serviceTier: CodexRunnerServiceTier;
  reasoningEffort: CodexRunnerReasoningEffort;
  dryRun: boolean;
  json: boolean;
  jobId?: string;
  earlyWaitSeconds?: number;
  outputFile?: string;
  logFile?: string;
  instructionCopyFile?: string;
  statusFile?: string;
  combinedLogFile?: string;
  launcherFile?: string;
  stdout: string;
  stderr: string;
  command: string[];
  launchCommand?: string[];
}

interface DetachedJob {
  jobId: string;
  jobDir: string;
  statusFile: string;
  combinedLogFile: string;
  launcherFile: string;
  launchCommand: string[];
}

interface DetachedStatusFile {
  status?: string;
  jobId?: string;
  exitCode?: number | null;
  updatedAt?: string;
}

function parseIntegerEnv(value: string | undefined, fallback: number, name: string, max: number): number {
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > max) {
    throw new Error(`${name} must be an integer between 1 and ${max}.`);
  }
  return parsed;
}

function normalizeTimeoutSeconds(value: number | undefined): number {
  if (value === undefined) return DEFAULT_TIMEOUT_SECONDS;
  if (!Number.isInteger(value) || value < 1 || value > MAX_TIMEOUT_SECONDS) {
    throw new Error(`timeout must be an integer between 1 and ${MAX_TIMEOUT_SECONDS} seconds.`);
  }
  return value;
}

function normalizeEarlyWaitSeconds(value: number | undefined, env: NodeJS.ProcessEnv): number {
  if (value !== undefined) {
    if (!Number.isInteger(value) || value < 1 || value > MAX_EARLY_WAIT_SECONDS) {
      throw new Error(`earlyWaitSeconds must be an integer between 1 and ${MAX_EARLY_WAIT_SECONDS} seconds.`);
    }
    return value;
  }
  return parseIntegerEnv(
    env.DEVSPACE_CODEX_EARLY_WAIT_SECONDS,
    DEFAULT_EARLY_WAIT_SECONDS,
    "DEVSPACE_CODEX_EARLY_WAIT_SECONDS",
    MAX_EARLY_WAIT_SECONDS,
  );
}

function normalizeMaxOutputCharacters(value: number | undefined): number {
  if (value === undefined) return DEFAULT_MAX_OUTPUT_CHARACTERS;
  if (!Number.isInteger(value) || value < 1 || value > 500_000) {
    throw new Error("maxOutputCharacters must be an integer between 1 and 500000.");
  }
  return value;
}

function normalizeMaxFallbackPromptCharacters(value: number | undefined): number {
  if (value === undefined) return DEFAULT_MAX_FALLBACK_PROMPT_CHARACTERS;
  if (!Number.isInteger(value) || value < 1 || value > 500_000) {
    throw new Error("maxFallbackPromptCharacters must be an integer between 1 and 500000.");
  }
  return value;
}

function normalizeSandbox(value: string | undefined): CodexSandbox {
  const sandbox = value ?? "read-only";
  if (sandbox === "read-only" || sandbox === "workspace-write") return sandbox;
  throw new Error(`Unsupported sandbox for run_codex_cli: ${sandbox}`);
}

function normalizeMode(value: string | undefined): CodexRunnerMode {
  const mode = value ?? "sync";
  if (mode === "sync" || mode === "detached") return mode;
  throw new Error(`Unsupported mode for run_codex_cli: ${mode}`);
}

function normalizeModel(value: string | undefined): string {
  const model = value?.trim() || DEFAULT_CODEX_MODEL;
  if (!model) throw new Error("model must not be empty.");
  return model;
}

function normalizeServiceTier(value: string | undefined): CodexRunnerServiceTier {
  const serviceTier = value ?? DEFAULT_CODEX_SERVICE_TIER;
  if (serviceTier === "standard" || serviceTier === "fast") return serviceTier;
  throw new Error(`Unsupported serviceTier for run_codex_cli: ${serviceTier}`);
}

function normalizeReasoningEffort(value: string | undefined): CodexRunnerReasoningEffort {
  const reasoningEffort = value ?? DEFAULT_CODEX_REASONING_EFFORT;
  if (CODEX_RUNNER_REASONING_EFFORT_VALUES.includes(reasoningEffort as CodexRunnerReasoningEffort)) {
    return reasoningEffort as CodexRunnerReasoningEffort;
  }
  throw new Error(`Unsupported reasoningEffort for run_codex_cli: ${reasoningEffort}`);
}

function resolveInputPath(path: string, cwd: string): string {
  return resolve(cwd, expandHomePath(path));
}

async function assertExistingDirectory(path: string, label: string): Promise<string> {
  const info = await stat(path);
  if (!info.isDirectory()) throw new Error(`${label} is not a directory: ${path}`);
  return path;
}

async function assertExistingFile(path: string, label: string): Promise<string> {
  const info = await stat(path);
  if (!info.isFile()) throw new Error(`${label} is not a file: ${path}`);
  return path;
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export function decodeCodexRunnerText(buffer: Buffer): string {
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    return buffer.subarray(2).toString("utf16le").replace(/^\uFEFF/, "");
  }
  if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    return buffer.subarray(3).toString("utf8").replace(/^\uFEFF/, "");
  }

  const sample = buffer.subarray(0, Math.min(buffer.length, 200));
  let oddNulls = 0;
  let evenNulls = 0;
  for (let index = 0; index < sample.length; index += 1) {
    if (sample[index] !== 0) continue;
    if (index % 2 === 0) evenNulls += 1;
    else oddNulls += 1;
  }
  if (oddNulls > 0 && oddNulls >= Math.max(2, evenNulls * 3)) {
    return buffer.toString("utf16le").replace(/^\uFEFF/, "");
  }

  return buffer.toString("utf8").replace(/^\uFEFF/, "");
}

async function readFileIfExists(path: string): Promise<string> {
  try {
    return decodeCodexRunnerText(await readFile(path));
  } catch {
    return "";
  }
}

async function readStatusFile(path: string): Promise<DetachedStatusFile | undefined> {
  const content = await readFileIfExists(path);
  const trimmed = content.trim().replace(/^\uFEFF/, "");
  if (!trimmed) return undefined;
  try {
    return JSON.parse(trimmed) as DetachedStatusFile;
  } catch {
    return undefined;
  }
}

function assertMarkdownFile(path: string): void {
  if (extname(path).toLowerCase() !== ".md") {
    throw new Error(`instructionFile must resolve to a .md file: ${path}`);
  }
}

export function codexCliRunnerCandidatePaths(
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
): string[] {
  const explicit = env.DEVSPACE_CODEX_CLI_RUNNER?.trim();
  if (explicit) return [resolveInputPath(explicit, cwd)];

  const moduleDir = dirname(fileURLToPath(import.meta.url));
  return [
    resolve(cwd, "labs", "codex_cli_runner", "run_codex.py"),
    resolve(cwd, "..", "..", "labs", "codex_cli_runner", "run_codex.py"),
    resolve(moduleDir, "..", "..", "labs", "codex_cli_runner", "run_codex.py"),
  ];
}

async function resolveRunnerPath(
  allowedRoots: string[],
  env: NodeJS.ProcessEnv,
  cwd: string,
): Promise<string> {
  const candidates = codexCliRunnerCandidatePaths(env, cwd);
  for (const candidate of candidates) {
    const allowedCandidate = assertAllowedPath(candidate, allowedRoots);
    if (await fileExists(allowedCandidate)) {
      return assertExistingFile(allowedCandidate, "Codex CLI runner");
    }
  }

  throw new Error(
    [
      "Codex CLI runner was not found.",
      "Set DEVSPACE_CODEX_CLI_RUNNER or place it at labs/codex_cli_runner/run_codex.py.",
      "Searched:",
      ...candidates.map((candidate) => `- ${candidate}`),
    ].join("\n"),
  );
}

async function resolveInstructionFile(
  rawInstructionFile: string,
  projectDir: string,
  runnerDir: string,
  allowedRoots: string[],
  cwd: string,
): Promise<string> {
  const raw = expandHomePath(rawInstructionFile);
  const candidates = raw.startsWith("/") || /^[A-Za-z]:[\\/]/.test(raw)
    ? [resolve(raw)]
    : [
        resolve(projectDir, raw),
        resolve(cwd, raw),
        resolve(runnerDir, raw),
      ];

  for (const candidate of candidates) {
    const allowedCandidate = assertAllowedPath(candidate, allowedRoots);
    if (await fileExists(allowedCandidate)) {
      assertMarkdownFile(allowedCandidate);
      return assertExistingFile(allowedCandidate, "instructionFile");
    }
  }

  throw new Error(
    [
      "instructionFile was not found.",
      `Raw value: ${rawInstructionFile}`,
      "Searched:",
      ...candidates.map((candidate) => `- ${candidate}`),
    ].join("\n"),
  );
}

function buildCommand(resolved: Omit<ResolvedCodexCliRunnerRequest, "command">): string[] {
  const command = [
    resolved.pythonCommand,
    resolved.runnerPath,
    resolved.projectDir,
    resolved.instructionFile,
    "--sandbox",
    resolved.sandbox,
    "--model",
    resolved.model,
    "--service-tier",
    resolved.serviceTier,
    "--reasoning-effort",
    resolved.reasoningEffort,
  ];

  if (resolved.json) command.push("--json");
  if (resolved.dryRun) command.push("--dry-run");

  return command;
}

export async function resolveCodexCliRunnerRequest(
  input: RunCodexCliRunnerInput,
  options: RunCodexCliRunnerOptions,
): Promise<ResolvedCodexCliRunnerRequest> {
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;
  const sandbox = normalizeSandbox(input.sandbox);
  const mode = normalizeMode(input.mode);
  const model = normalizeModel(input.model);
  const serviceTier = normalizeServiceTier(input.serviceTier);
  const reasoningEffort = normalizeReasoningEffort(input.reasoningEffort);
  const dryRun = input.dryRun ?? false;
  const json = input.json ?? false;
  const timeoutSeconds = normalizeTimeoutSeconds(input.timeout);
  const earlyWaitSeconds = normalizeEarlyWaitSeconds(input.earlyWaitSeconds, env);
  const maxOutputCharacters = normalizeMaxOutputCharacters(input.maxOutputCharacters);
  const maxFallbackPromptCharacters = normalizeMaxFallbackPromptCharacters(input.maxFallbackPromptCharacters);
  const pythonCommand = options.pythonCommand ?? env.DEVSPACE_PYTHON_COMMAND?.trim() ?? "python";

  const projectDir = await assertExistingDirectory(
    assertAllowedPath(resolveInputPath(input.projectDir, cwd), options.allowedRoots),
    "projectDir",
  );
  const runnerPath = await resolveRunnerPath(options.allowedRoots, env, cwd);
  const runnerDir = dirname(runnerPath);
  const instructionFile = await resolveInstructionFile(
    input.instructionFile,
    projectDir,
    runnerDir,
    options.allowedRoots,
    cwd,
  );

  const withoutCommand = {
    projectDir,
    instructionFile,
    runnerPath,
    runnerDir,
    sandbox,
    mode,
    model,
    serviceTier,
    reasoningEffort,
    dryRun,
    json,
    timeoutSeconds,
    earlyWaitSeconds,
    maxOutputCharacters,
    maxFallbackPromptCharacters,
    pythonCommand,
  };

  return {
    ...withoutCommand,
    command: buildCommand(withoutCommand),
  };
}

function truncateText(text: string, maxCharacters: number): string {
  if (text.length <= maxCharacters) return text;
  return `${text.slice(0, maxCharacters)}\n...[truncated ${text.length - maxCharacters} characters]`;
}

function parseOutputPath(label: string, text: string): string | undefined {
  const pattern = new RegExp(`^${label}:\\s*(.+)$`, "m");
  const match = text.match(pattern);
  return match?.[1]?.trim();
}

function detectErrorKind(result: {
  exitCode: number | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
}): CodexRunnerErrorKind {
  if (result.timedOut) return "timeout";
  if (result.exitCode === 0) return "none";

  const text = `${result.stdout}\n${result.stderr}`.toLowerCase();
  if (/\b(enoent|not found)\b/.test(text) && /\b(python|spawn)\b/.test(text)) {
    return "python_not_found";
  }
  if (
    /usage limit|rate limit|rate_limit|limit reached|too many requests|quota|insufficient_quota|credit balance|credits exhausted|token limit|context length|maximum context/.test(text)
  ) {
    return "codex_limit";
  }

  if (result.exitCode !== null && result.exitCode !== 0) return "codex_failed";
  return "unknown";
}

function defaultStatusFor(errorKind: CodexRunnerErrorKind, exitCode: number | null): CodexRunnerStatus {
  if (errorKind === "none" && exitCode === 0) return "completed";
  if (errorKind === "codex_limit") return "limit_error";
  if (errorKind === "timeout") return "timeout";
  if (errorKind === "python_not_found") return "launch_error";
  return "failed";
}

function formatResult(result: Omit<CodexCliRunnerResult, "result">): string {
  const continuationInstruction = result.nextAction === "continue_in_chatgpt"
    ? [
        "",
        "## Required next action for ChatGPT",
        "Codex returned a limit-related error and cannot continue right now.",
        "Do not stop at reporting the Codex limit or only telling the user to retry later.",
        "Continue the same task in ChatGPT now using the `fallbackPrompt` below, unless the user explicitly asked not to continue.",
      ].join("\n")
    : undefined;
  const lines = [
    `Codex CLI runner ${result.status}.`,
    `status: ${result.status}`,
    `mode: ${result.mode}`,
    `exitCode: ${result.exitCode ?? "null"}`,
    `timedOut: ${result.timedOut}`,
    `errorKind: ${result.errorKind}`,
    `nextAction: ${result.nextAction}`,
    `fallbackRecommended: ${result.fallbackRecommended}`,
    `projectDir: ${result.projectDir}`,
    `instructionFile: ${result.instructionFile}`,
    `sandbox: ${result.sandbox}`,
    `model: ${result.model}`,
    `serviceTier: ${result.serviceTier}`,
    `reasoningEffort: ${result.reasoningEffort}`,
    `dryRun: ${result.dryRun}`,
    result.jobId ? `jobId: ${result.jobId}` : undefined,
    result.earlyWaitSeconds ? `earlyWaitSeconds: ${result.earlyWaitSeconds}` : undefined,
    result.outputFile ? `outputFile: ${result.outputFile}` : undefined,
    result.logFile ? `logFile: ${result.logFile}` : undefined,
    result.instructionCopyFile ? `instructionCopyFile: ${result.instructionCopyFile}` : undefined,
    result.statusFile ? `statusFile: ${result.statusFile}` : undefined,
    result.combinedLogFile ? `combinedLogFile: ${result.combinedLogFile}` : undefined,
    result.launcherFile ? `launcherFile: ${result.launcherFile}` : undefined,
    continuationInstruction,
    "",
    "## Output",
    result.stdout || result.stderr || "(no output)",
    result.fallbackRecommended && result.fallbackPrompt
      ? [
          "",
          "## ChatGPT fallback prompt",
          "Use this Markdown instruction as the continuation prompt for ChatGPT.",
          "",
          `Source: ${result.fallbackPromptSource}`,
          `Truncated: ${result.fallbackPromptTruncated ?? false}`,
          "",
          result.fallbackPrompt,
        ].join("\n")
      : undefined,
  ];

  return lines.filter((line) => line !== undefined).join("\n");
}

async function buildFallbackPrompt(
  errorKind: CodexRunnerErrorKind,
  resolved: ResolvedCodexCliRunnerRequest,
): Promise<{
  fallbackRecommended: boolean;
  fallbackPrompt?: string;
  fallbackPromptSource?: string;
  fallbackPromptTruncated?: boolean;
}> {
  if (errorKind !== "codex_limit") {
    return { fallbackRecommended: false };
  }

  const instruction = await readFile(resolved.instructionFile, "utf8");
  const fallbackPromptTruncated = instruction.length > resolved.maxFallbackPromptCharacters;
  return {
    fallbackRecommended: true,
    fallbackPrompt: truncateText(instruction, resolved.maxFallbackPromptCharacters),
    fallbackPromptSource: resolved.instructionFile,
    fallbackPromptTruncated,
  };
}

async function finalizeRunnerResult(
  partial: Omit<
    CodexCliRunnerResult,
    | "result"
    | "status"
    | "errorKind"
    | "nextAction"
    | "fallbackRecommended"
    | "fallbackPrompt"
    | "fallbackPromptSource"
    | "fallbackPromptTruncated"
    | "model"
    | "serviceTier"
    | "reasoningEffort"
  >,
  resolved: ResolvedCodexCliRunnerRequest,
  statusOverride?: CodexRunnerStatus,
): Promise<CodexCliRunnerResult> {
  const errorKind = detectErrorKind(partial);
  const fallback = await buildFallbackPrompt(errorKind, resolved);
  const nextAction: CodexRunnerNextAction = fallback.fallbackRecommended
    ? "continue_in_chatgpt"
    : "none";
  const status = statusOverride ?? defaultStatusFor(errorKind, partial.exitCode);
  const complete = {
    ...partial,
    status,
    errorKind,
    nextAction,
    model: resolved.model,
    serviceTier: resolved.serviceTier,
    reasoningEffort: resolved.reasoningEffort,
    ...fallback,
  };
  return { ...complete, result: formatResult(complete) };
}

function nowStamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function psSingleQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function shSingleQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function statusJson(jobId: string, status: string, exitCode: number | null = null): string {
  return JSON.stringify({
    status,
    jobId,
    exitCode,
    updatedAt: new Date().toISOString(),
  });
}

async function createDetachedJob(resolved: ResolvedCodexCliRunnerRequest): Promise<DetachedJob> {
  const jobId = `${nowStamp()}_${randomUUID().slice(0, 8)}`;
  const jobDir = join(resolved.projectDir, ".codex", "runs", `devspace_codex_${jobId}`);
  await mkdir(jobDir, { recursive: true });

  const statusFile = join(jobDir, "status.json");
  const combinedLogFile = join(jobDir, "codex_combined.log");
  const isWindows = platform() === "win32";
  const launcherFile = join(jobDir, isWindows ? "launch-codex.ps1" : "launch-codex.sh");

  if (isWindows) {
    const psArgs = resolved.command.slice(1).map(psSingleQuote).join(", ");
    const content = [
      "$ErrorActionPreference = 'Continue'",
      "$Utf8NoBom = [System.Text.UTF8Encoding]::new($false)",
      "$OutputEncoding = $Utf8NoBom",
      `[Console]::OutputEncoding = $Utf8NoBom`,
      `$jobId = ${psSingleQuote(jobId)}`,
      `$statusFile = ${psSingleQuote(statusFile)}`,
      `$logFile = ${psSingleQuote(combinedLogFile)}`,
      "function Write-DevSpaceStatus([string]$status, [Nullable[int]]$exitCode) {",
      "  $obj = [ordered]@{ status = $status; jobId = $jobId; exitCode = $exitCode; updatedAt = (Get-Date).ToString('o') }",
      "  [System.IO.File]::WriteAllText($statusFile, ($obj | ConvertTo-Json -Compress), $Utf8NoBom)",
      "}",
      "if (Test-Path -LiteralPath $logFile) { Remove-Item -LiteralPath $logFile -Force }",
      "Write-DevSpaceStatus 'running' $null",
      `Set-Location -LiteralPath ${psSingleQuote(resolved.runnerDir)}`,
      `$codexArgs = @(${psArgs})`,
      `& ${psSingleQuote(resolved.pythonCommand)} @codexArgs 2>&1 | ForEach-Object { $line = [string]$_; [Console]::Out.WriteLine($line); [System.IO.File]::AppendAllText($logFile, $line + [Environment]::NewLine, $Utf8NoBom) }`,
      "$exitCode = if ($null -eq $LASTEXITCODE) { 0 } else { [int]$LASTEXITCODE }",
      "if ($exitCode -eq 0) { Write-DevSpaceStatus 'completed' $exitCode } else { Write-DevSpaceStatus 'failed' $exitCode }",
      "Write-Host ''",
      "Write-Host ('DevSpace Codex job finished. exitCode=' + $exitCode)",
      "Write-Host ('Status: ' + $statusFile)",
      "Write-Host ('Log: ' + $logFile)",
      "exit $exitCode",
      "",
    ].join("\n");
    await writeFile(launcherFile, content, "utf8");
    return {
      jobId,
      jobDir,
      statusFile,
      combinedLogFile,
      launcherFile,
      launchCommand: [
        "cmd.exe",
        "/c",
        "start",
        `Codex CLI ${jobId}`,
        "powershell.exe",
        "-NoExit",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        launcherFile,
      ],
    };
  }

  const shArgs = resolved.command.slice(1).map(shSingleQuote).join(" ");
  const content = [
    "#!/usr/bin/env bash",
    "set -o pipefail",
    `status_file=${shSingleQuote(statusFile)}`,
    `log_file=${shSingleQuote(combinedLogFile)}`,
    `printf '%s' ${shSingleQuote(statusJson(jobId, "running"))} > "$status_file"`,
    `cd ${shSingleQuote(resolved.runnerDir)}`,
    `${shSingleQuote(resolved.pythonCommand)} ${shArgs} 2>&1 | tee "$log_file"`,
    "exit_code=$?",
    `if [ "$exit_code" -eq 0 ]; then printf '%s' ${shSingleQuote(statusJson(jobId, "completed", 0))} > "$status_file"; else printf '{\"status\":\"failed\",\"jobId\":\"${jobId}\",\"exitCode\":%s,\"updatedAt\":\"%s\"}' "$exit_code" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$status_file"; fi`,
    "exit $exit_code",
    "",
  ].join("\n");
  await writeFile(launcherFile, content, { encoding: "utf8", mode: 0o700 });
  return {
    jobId,
    jobDir,
    statusFile,
    combinedLogFile,
    launcherFile,
    launchCommand: ["bash", launcherFile],
  };
}

function spawnDetached(job: DetachedJob): Promise<{ child?: ChildProcess; error?: Error }> {
  return new Promise((resolvePromise) => {
    const [command, ...args] = job.launchCommand;
    if (!command) {
      resolvePromise({ error: new Error("Missing detached launch command.") });
      return;
    }

    const child = spawn(command, args, {
      cwd: job.jobDir,
      detached: true,
      stdio: "ignore",
      windowsHide: false,
    });
    let settled = false;
    const settle = (result: { child?: ChildProcess; error?: Error }) => {
      if (settled) return;
      settled = true;
      resolvePromise(result);
    };

    child.once("error", (error) => settle({ child, error }));
    child.unref();
    setTimeout(() => settle({ child }), 250);
  });
}

function launchErrorResult(
  resolved: ResolvedCodexCliRunnerRequest,
  job: DetachedJob,
  error: Error,
): CodexCliRunnerResult {
  const complete = {
    status: "launch_error" as const,
    exitCode: null,
    timedOut: false,
    errorKind: "unknown" as const,
    nextAction: "none" as const,
    fallbackRecommended: false,
    projectDir: resolved.projectDir,
    instructionFile: resolved.instructionFile,
    runnerPath: resolved.runnerPath,
    sandbox: resolved.sandbox,
    mode: resolved.mode,
    model: resolved.model,
    serviceTier: resolved.serviceTier,
    reasoningEffort: resolved.reasoningEffort,
    dryRun: resolved.dryRun,
    json: resolved.json,    jobId: job.jobId,
    earlyWaitSeconds: resolved.earlyWaitSeconds,
    statusFile: job.statusFile,
    combinedLogFile: job.combinedLogFile,
    launcherFile: job.launcherFile,
    stdout: "",
    stderr: `${error.name}: ${error.message}`,
    command: resolved.command,
    launchCommand: job.launchCommand,
  };
  return { ...complete, result: formatResult(complete) };
}

function dryRunResult(resolved: ResolvedCodexCliRunnerRequest): CodexCliRunnerResult {
  const output = [
    "Dry run only. Codex was not executed and no detached console was opened.",
    `Mode:        ${resolved.mode}`,
    `Sandbox:     ${resolved.sandbox}`,
    `Model:       ${resolved.model}`,
    `Tier:        ${resolved.serviceTier}`,
    `Reasoning:   ${resolved.reasoningEffort}`,
    "Command:",    `Sandbox:     ${resolved.sandbox}`,
    "Command:",
    resolved.command.join(" "),
  ].join("\n");
  const complete = {
    status: "dry_run" as const,
    exitCode: 0,
    timedOut: false,
    errorKind: "none" as const,
    nextAction: "none" as const,
    fallbackRecommended: false,
    projectDir: resolved.projectDir,
    instructionFile: resolved.instructionFile,
    runnerPath: resolved.runnerPath,
    sandbox: resolved.sandbox,
    mode: resolved.mode,
    model: resolved.model,
    serviceTier: resolved.serviceTier,
    reasoningEffort: resolved.reasoningEffort,
    dryRun: resolved.dryRun,
    json: resolved.json,    earlyWaitSeconds: resolved.earlyWaitSeconds,
    stdout: output,
    stderr: "",
    command: resolved.command,
  };
  return { ...complete, result: formatResult(complete) };
}

async function monitorDetachedJob(
  resolved: ResolvedCodexCliRunnerRequest,
  job: DetachedJob,
): Promise<CodexCliRunnerResult> {
  const deadline = Date.now() + resolved.earlyWaitSeconds * 1000;

  while (Date.now() <= deadline) {
    const status = await readStatusFile(job.statusFile);
    const logText = await readFileIfExists(job.combinedLogFile);
    const truncatedLog = truncateText(logText, resolved.maxOutputCharacters);

    if (status?.status === "completed") {
      const partial = {
        exitCode: status.exitCode ?? 0,
        timedOut: false,
        projectDir: resolved.projectDir,
        instructionFile: resolved.instructionFile,
        runnerPath: resolved.runnerPath,
        sandbox: resolved.sandbox,
        mode: resolved.mode,
        dryRun: resolved.dryRun,
        json: resolved.json,
        jobId: job.jobId,
        earlyWaitSeconds: resolved.earlyWaitSeconds,
        statusFile: job.statusFile,
        combinedLogFile: job.combinedLogFile,
        launcherFile: job.launcherFile,
        stdout: truncatedLog,
        stderr: "",
        command: resolved.command,
        launchCommand: job.launchCommand,
      };
      return await finalizeRunnerResult(partial, resolved, "completed");
    }

    const statusFailed = status?.status === "failed";
    const probe = {
      exitCode: statusFailed ? status.exitCode ?? 1 : 1,
      timedOut: false,
      stdout: truncatedLog,
      stderr: "",
    };
    const errorKind = detectErrorKind(probe);
    if (errorKind === "codex_limit") {
      const partial = {
        exitCode: status?.exitCode ?? 1,
        timedOut: false,
        projectDir: resolved.projectDir,
        instructionFile: resolved.instructionFile,
        runnerPath: resolved.runnerPath,
        sandbox: resolved.sandbox,
        mode: resolved.mode,
        dryRun: resolved.dryRun,
        json: resolved.json,
        jobId: job.jobId,
        earlyWaitSeconds: resolved.earlyWaitSeconds,
        statusFile: job.statusFile,
        combinedLogFile: job.combinedLogFile,
        launcherFile: job.launcherFile,
        stdout: truncatedLog,
        stderr: "",
        command: resolved.command,
        launchCommand: job.launchCommand,
      };
      return await finalizeRunnerResult(partial, resolved, "limit_error");
    }

    if (statusFailed) {
      const partial = {
        exitCode: status.exitCode ?? 1,
        timedOut: false,
        projectDir: resolved.projectDir,
        instructionFile: resolved.instructionFile,
        runnerPath: resolved.runnerPath,
        sandbox: resolved.sandbox,
        mode: resolved.mode,
        dryRun: resolved.dryRun,
        json: resolved.json,
        jobId: job.jobId,
        earlyWaitSeconds: resolved.earlyWaitSeconds,
        statusFile: job.statusFile,
        combinedLogFile: job.combinedLogFile,
        launcherFile: job.launcherFile,
        stdout: truncatedLog,
        stderr: "",
        command: resolved.command,
        launchCommand: job.launchCommand,
      };
      return await finalizeRunnerResult(partial, resolved, "early_error");
    }

    await new Promise((resolveDelay) => setTimeout(resolveDelay, 500));
  }

  const finalStatus = await readStatusFile(job.statusFile);
  const logText = await readFileIfExists(job.combinedLogFile);
  const truncatedLog = truncateText(logText, resolved.maxOutputCharacters);
  const commonPartial = {
    timedOut: false,
    projectDir: resolved.projectDir,
    instructionFile: resolved.instructionFile,
    runnerPath: resolved.runnerPath,
    sandbox: resolved.sandbox,
    mode: resolved.mode,
    dryRun: resolved.dryRun,
    json: resolved.json,
    jobId: job.jobId,
    earlyWaitSeconds: resolved.earlyWaitSeconds,
    statusFile: job.statusFile,
    combinedLogFile: job.combinedLogFile,
    launcherFile: job.launcherFile,
    stderr: "",
    command: resolved.command,
    launchCommand: job.launchCommand,
  };

  if (finalStatus?.status === "completed") {
    return await finalizeRunnerResult({
      ...commonPartial,
      exitCode: finalStatus.exitCode ?? 0,
      stdout: truncatedLog,
    }, resolved, "completed");
  }

  if (finalStatus?.status === "failed") {
    const partial = {
      ...commonPartial,
      exitCode: finalStatus.exitCode ?? 1,
      stdout: truncatedLog,
    };
    const errorKind = detectErrorKind(partial);
    return await finalizeRunnerResult(
      partial,
      resolved,
      errorKind === "codex_limit" ? "limit_error" : "early_error",
    );
  }

  const partial = {
    ...commonPartial,
    exitCode: null,
    stdout: truncateText(
      [
        `Codex was launched in detached mode and no early error was detected within ${resolved.earlyWaitSeconds} seconds.`,
        `The detached process may still be running in its own console.`,
        `Status file: ${job.statusFile}`,
        `Log file: ${job.combinedLogFile}`,
        logText ? "" : undefined,
        logText || undefined,
      ].filter(Boolean).join("\n"),
      resolved.maxOutputCharacters,
    ),
  };
  return await finalizeRunnerResult(partial, resolved, "started_running");
}

async function runDetachedCodexCliRunner(
  resolved: ResolvedCodexCliRunnerRequest,
): Promise<CodexCliRunnerResult> {
  if (resolved.dryRun) return dryRunResult(resolved);

  const job = await createDetachedJob(resolved);
  const launched = await spawnDetached(job);
  if (launched.error) return launchErrorResult(resolved, job, launched.error);
  return await monitorDetachedJob(resolved, job);
}

async function runSyncCodexCliRunner(
  resolved: ResolvedCodexCliRunnerRequest,
): Promise<CodexCliRunnerResult> {
  const timeoutMs = resolved.timeoutSeconds * 1000;

  return await new Promise<CodexCliRunnerResult>((resolvePromise) => {
    const child = spawn(resolved.pythonCommand, resolved.command.slice(1), {
      cwd: resolved.runnerDir,
      shell: false,
      windowsHide: true,
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let forceKillTimer: NodeJS.Timeout | undefined;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      forceKillTimer = setTimeout(() => child.kill("SIGKILL"), 5_000);
    }, timeoutMs);

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });

    child.on("error", (error) => {
      void (async () => {
        clearTimeout(timeout);
        if (forceKillTimer) clearTimeout(forceKillTimer);
        stderr += `${error.name}: ${error.message}\n`;
        const truncatedStdout = truncateText(stdout, resolved.maxOutputCharacters);
        const truncatedStderr = truncateText(stderr, resolved.maxOutputCharacters);
        const partial = {
          exitCode: null,
          timedOut,
          projectDir: resolved.projectDir,
          instructionFile: resolved.instructionFile,
          runnerPath: resolved.runnerPath,
          sandbox: resolved.sandbox,
          mode: resolved.mode,
          dryRun: resolved.dryRun,
          json: resolved.json,
          stdout: truncatedStdout,
          stderr: truncatedStderr,
          command: resolved.command,
        };
        resolvePromise(await finalizeRunnerResult(partial, resolved));
      })();
    });

    child.on("close", (code) => {
      void (async () => {
        clearTimeout(timeout);
        if (forceKillTimer) clearTimeout(forceKillTimer);
        const combined = `${stdout}${stderr ? `\n${stderr}` : ""}`;
        const truncatedStdout = truncateText(stdout, resolved.maxOutputCharacters);
        const truncatedStderr = truncateText(stderr, resolved.maxOutputCharacters);
        const partial = {
          exitCode: code,
          timedOut,
          projectDir: resolved.projectDir,
          instructionFile: resolved.instructionFile,
          runnerPath: resolved.runnerPath,
          sandbox: resolved.sandbox,
          mode: resolved.mode,
          dryRun: resolved.dryRun,
          json: resolved.json,
          outputFile: parseOutputPath("Output", combined),
          logFile: parseOutputPath("Log", combined),
          instructionCopyFile: parseOutputPath("Instruction", combined),
          stdout: truncatedStdout,
          stderr: truncatedStderr,
          command: resolved.command,
        };
        resolvePromise(await finalizeRunnerResult(partial, resolved));
      })();
    });
  });
}

export async function runCodexCliRunner(
  input: RunCodexCliRunnerInput,
  options: RunCodexCliRunnerOptions,
): Promise<CodexCliRunnerResult> {
  const resolved = await resolveCodexCliRunnerRequest(input, options);
  if (resolved.mode === "detached") return await runDetachedCodexCliRunner(resolved);
  return await runSyncCodexCliRunner(resolved);
}
