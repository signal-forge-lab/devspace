import { spawn } from "node:child_process";
import { buildChildProcessEnvironment } from "./child-environment.js";
import {
  isWindowsCommandShim,
  RequiredExecutableMissingError,
  resolveExecutablePath,
} from "./executable-resolution.js";
import { resolveShellCommand, terminateProcessTree } from "./process-platform.js";
import { redactPathsInText, type PathRedaction } from "./path-redaction.js";
import type {
  WorkspaceActionArtifact,
  WorkspaceActionExecutionPlan,
  WorkspaceActionPlanStep,
  WorkspaceActionProcessStep,
  WorkspaceActionStepResult,
} from "./workspace-action-plans.js";
import { writeWorkspaceJsonArtifact } from "./workspace-json-artifact.js";

const DEFAULT_EXEC_YIELD_MS = 10_000;
const DEFAULT_INTERACTIVE_YIELD_MS = 250;
const DEFAULT_POLL_YIELD_MS = 5_000;
const MAX_COMMAND_YIELD_MS = 30_000;
const MAX_POLL_YIELD_MS = 110_000;
const DEFAULT_MAX_OUTPUT_TOKENS = 10_000;
const DEFAULT_BUFFER_CHARACTERS = 1_000_000;
const COMPLETED_SESSION_TTL_MS = 5 * 60 * 1_000;
const DEFAULT_COLUMNS = 80;
const DEFAULT_ROWS = 24;

export interface StartCommandInput {
  workspaceId: string;
  command: string;
  cwd: string;
  workspaceRoot?: string;
  outputRedactions?: PathRedaction[];
  outputMode?: "full" | "status";
  tty?: boolean;
  columns?: number;
  rows?: number;
  yieldTimeMs?: number;
  maxOutputTokens?: number;
  context?: ProcessSessionContext;
}

export interface StartActionPlanInput {
  workspaceId: string;
  plan: WorkspaceActionExecutionPlan;
  plannedArtifacts?: WorkspaceActionArtifact[];
  cwd: string;
  workspaceRoot?: string;
  outputRedactions?: PathRedaction[];
  outputMode?: "full" | "status";
  tty?: boolean;
  columns?: number;
  rows?: number;
  yieldTimeMs?: number;
  maxOutputTokens?: number;
  context: WorkspaceActionProcessContext;
}

export interface WriteStdinInput {
  workspaceId: string;
  sessionId: number;
  chars?: string;
  columns?: number;
  rows?: number;
  yieldTimeMs?: number;
  maxOutputTokens?: number;
}

export interface ProcessSnapshot {
  sessionId?: number;
  output: string;
  outputTruncated: boolean;
  outputSuppressed?: boolean;
  running: boolean;
  exitCode?: number;
  signal?: string;
  wallTimeMs: number;
  cancelled?: boolean;
  context?: ProcessSessionContext;
}

export interface WorkspaceActionProcessContext {
  kind: "workspace_action";
  contractVersion: 2;
  action: string;
  preset: string;
  profile?: string;
  policy: string[];
  commandPreview?: string;
  profileEvidence: string[];
  warnings: string[];
  artifacts: WorkspaceActionArtifact[];
  steps: WorkspaceActionStepResult[];
}

export type ProcessSessionContext = WorkspaceActionProcessContext;

interface ManagedProcess {
  write(data: string): void;
  kill(signal?: NodeJS.Signals): void;
  resize?(columns: number, rows: number): void;
}

interface ProcessSession {
  id: number;
  workspaceId: string;
  process?: ManagedProcess;
  startedAt: number;
  columns: number;
  rows: number;
  buffer: HeadTailBuffer;
  outputRedactions: PathRedaction[];
  outputMode: "full" | "status";
  running: boolean;
  exitCode?: number;
  signal?: string;
  cancelRequested: boolean;
  context?: ProcessSessionContext;
  exitPromise: Promise<void>;
  resolveExit: () => void;
  cleanupTimer?: NodeJS.Timeout;
}

interface ProcessSessionManagerOptions {
  maxBufferCharacters?: number;
  completedSessionTtlMs?: number;
  onBufferAppend?: (output: string) => void;
}

function boundedInteger(value: number | undefined, fallback: number, maximum: number): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value < 0) {
    throw new Error("Duration and output limits must be non-negative.");
  }
  return Math.min(Math.floor(value), maximum);
}

function terminalSize(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 1 || value > 1_000) {
    throw new Error("Terminal dimensions must be integers between 1 and 1000.");
  }
  return value;
}

function codePointLength(value: string): number {
  return Array.from(value).length;
}

function sliceCodePoints(value: string, start: number, end?: number): string {
  return Array.from(value).slice(start, end).join("");
}

function takeHead(value: string, count: number): string {
  if (count <= 0) return "";
  return sliceCodePoints(value, 0, count);
}

function takeTail(value: string, count: number): string {
  if (count <= 0) return "";
  const characters = Array.from(value);
  return characters.slice(Math.max(0, characters.length - count)).join("");
}

function splitBudget(maxCharacters: number): { head: number; tail: number } {
  return {
    head: Math.ceil(maxCharacters / 2),
    tail: Math.floor(maxCharacters / 2),
  };
}

function formatHeadTail(head: string, tail: string, omittedCharacters: number): string {
  if (omittedCharacters <= 0) return head + tail;
  return `${head}\n... output truncated (${omittedCharacters} characters omitted) ...\n${tail}`;
}

export class HeadTailBuffer {
  private head = "";
  private tail = "";
  private totalCharacters = 0;

  constructor(private readonly maxCharacters: number) {
    if (!Number.isInteger(maxCharacters) || maxCharacters < 1) {
      throw new Error("Head/tail buffer limit must be a positive integer.");
    }
  }

  append(output: string): void {
    if (!output) return;

    const previousTotal = this.totalCharacters;
    this.totalCharacters += codePointLength(output);

    if (this.totalCharacters <= this.maxCharacters) {
      this.head += output;
      return;
    }

    const budget = splitBudget(this.maxCharacters);
    if (previousTotal <= this.maxCharacters) {
      const fullOutput = this.head + output;
      this.head = takeHead(fullOutput, budget.head);
      this.tail = takeTail(fullOutput, budget.tail);
      return;
    }

    this.tail = takeTail(this.tail + output, budget.tail);
  }

  hasOutput(): boolean {
    return this.totalCharacters > 0;
  }

  drain(maxCharacters: number): { output: string; truncated: boolean } {
    if (!Number.isInteger(maxCharacters) || maxCharacters < 1) {
      throw new Error("Output limit must be a positive integer.");
    }

    const omittedByBuffer = Math.max(
      0,
      this.totalCharacters - codePointLength(this.head) - codePointLength(this.tail),
    );
    const retained = formatHeadTail(this.head, this.tail, omittedByBuffer);
    const output = truncateOutput(retained, maxCharacters);
    const truncated = omittedByBuffer > 0 || output.truncated;

    this.head = "";
    this.tail = "";
    this.totalCharacters = 0;

    return { output: output.output, truncated };
  }
}

function truncateOutput(output: string, maxCharacters: number): { output: string; truncated: boolean } {
  const outputCharacters = codePointLength(output);
  if (outputCharacters <= maxCharacters) return { output, truncated: false };

  const marker = "\n... output truncated ...\n";
  const markerCharacters = codePointLength(marker);
  const available = Math.max(0, maxCharacters - markerCharacters);
  const budget = splitBudget(available);
  return {
    output: takeHead(output, budget.head) + marker + takeTail(output, budget.tail),
    truncated: true,
  };
}

export class ProcessSessionManager {
  private readonly sessions = new Map<number, ProcessSession>();
  private readonly maxBufferCharacters: number;
  private readonly completedSessionTtlMs: number;
  private readonly onBufferAppend?: (output: string) => void;
  private nextSessionId = 1;

  constructor(options: ProcessSessionManagerOptions = {}) {
    this.maxBufferCharacters = options.maxBufferCharacters ?? DEFAULT_BUFFER_CHARACTERS;
    this.completedSessionTtlMs = options.completedSessionTtlMs ?? COMPLETED_SESSION_TTL_MS;
    this.onBufferAppend = options.onBufferAppend;
  }

  async start(input: StartCommandInput): Promise<ProcessSnapshot> {
    const session = this.createSession(input);
    this.sessions.set(session.id, session);

    try {
      if (input.tty && process.platform !== "win32") await this.startPty(session, input);
      else this.startPipe(session, input);
    } catch (error) {
      this.sessions.delete(session.id);
      throw error;
    }

    const yieldTimeMs = boundedInteger(input.yieldTimeMs, DEFAULT_EXEC_YIELD_MS, MAX_COMMAND_YIELD_MS);
    await this.waitForExit(session, yieldTimeMs);

    const snapshot = this.consume(session, input.maxOutputTokens);
    if (!session.running) this.removeSession(session.id);
    return snapshot;
  }

  async startPlan(input: StartActionPlanInput): Promise<ProcessSnapshot> {
    const session = this.createSession(input);
    this.sessions.set(session.id, session);

    void this.runPlan(session, input).catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      this.append(session, `${message}\n`);
      this.markRemainingStepsSkipped(session);
      this.finish(session, 1);
    });

    const yieldTimeMs = boundedInteger(input.yieldTimeMs, DEFAULT_EXEC_YIELD_MS, MAX_COMMAND_YIELD_MS);
    await this.waitForExit(session, yieldTimeMs);

    const snapshot = this.consume(session, input.maxOutputTokens);
    if (!session.running) this.removeSession(session.id);
    return snapshot;
  }

  async write(input: WriteStdinInput): Promise<ProcessSnapshot> {
    const session = this.getOwnedSession(input.workspaceId, input.sessionId);
    const chars = input.chars ?? "";
    const interactionRequested =
      chars.length > 0 || input.columns !== undefined || input.rows !== undefined;

    if (input.columns !== undefined || input.rows !== undefined) {
      session.columns = terminalSize(input.columns, session.columns);
      session.rows = terminalSize(input.rows, session.rows);
      if (!session.process?.resize) {
        throw new Error(`Process session ${session.id} is not a PTY and cannot be resized.`);
      }
      session.process.resize(session.columns, session.rows);
    }

    const interruptRequested = chars.includes("\u0003") && session.running;
    if (interruptRequested) {
      session.cancelRequested = true;
      session.process?.kill("SIGINT");
    }
    const writableChars = chars.replaceAll("\u0003", "");
    if (writableChars && session.running) session.process?.write(writableChars);

    if ((interactionRequested || !session.buffer.hasOutput()) && session.running) {
      const fallback = interactionRequested ? DEFAULT_INTERACTIVE_YIELD_MS : DEFAULT_POLL_YIELD_MS;
      const maximum = interactionRequested ? MAX_COMMAND_YIELD_MS : MAX_POLL_YIELD_MS;
      const yieldTimeMs = boundedInteger(input.yieldTimeMs, fallback, maximum);
      await this.waitForExit(session, yieldTimeMs);
    }

    const snapshot = this.consume(session, input.maxOutputTokens);
    if (!session.running) this.removeSession(session.id);
    return snapshot;
  }

  terminate(workspaceId: string, sessionId: number): void {
    const session = this.getOwnedSession(workspaceId, sessionId);
    if (session.running) {
      session.cancelRequested = true;
      session.process?.kill("SIGTERM");
    }
  }

  shutdown(): void {
    for (const session of this.sessions.values()) {
      if (session.cleanupTimer) clearTimeout(session.cleanupTimer);
      if (session.running) session.process?.kill("SIGTERM");
    }
    this.sessions.clear();
  }

  private async waitForExit(session: ProcessSession, yieldTimeMs: number): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        session.exitPromise,
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, yieldTimeMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private createSession(input: StartCommandInput | StartActionPlanInput): ProcessSession {
    let resolveExit = (): void => undefined;
    const exitPromise = new Promise<void>((resolve) => {
      resolveExit = resolve;
    });

    return {
      id: this.nextSessionId++,
      workspaceId: input.workspaceId,
      startedAt: Date.now(),
      columns: terminalSize(input.columns, DEFAULT_COLUMNS),
      rows: terminalSize(input.rows, DEFAULT_ROWS),
      buffer: new HeadTailBuffer(this.maxBufferCharacters),
      outputRedactions: input.outputRedactions ?? [],
      outputMode: input.outputMode ?? "full",
      running: true,
      cancelRequested: false,
      context: input.context
        ? cloneProcessSessionContext(input.context)
        : undefined,
      exitPromise,
      resolveExit,
    };
  }

  private async runPlan(session: ProcessSession, input: StartActionPlanInput): Promise<void> {
    const context = session.context;
    if (context?.kind !== "workspace_action") {
      throw new Error("Workspace action plan sessions require workspace action context.");
    }

    for (let index = 0; index < input.plan.steps.length; index++) {
      const planStep = input.plan.steps[index];
      const resultStep = context.steps[index];
      if (!planStep || !resultStep) {
        throw new Error("Workspace action plan and result steps are out of sync.");
      }

      if (session.cancelRequested) {
        resultStep.status = "skipped";
        continue;
      }

      resultStep.status = "running";
      this.append(session, `==> [${singleLineStepText(planStep.id)}] ${singleLineStepText(planStep.label)}\n`);
      const stepStartedAt = Date.now();
      let outcome: { exitCode?: number; signal?: string };
      try {
        outcome = await this.runPlanStep(session, input, planStep);
      } catch (error) {
        resultStep.durationMs = Date.now() - stepStartedAt;
        resultStep.exitCode = 1;
        resultStep.status = "failed";
        this.append(session, `${error instanceof Error ? error.message : String(error)}\n`);
        this.append(session, stepEndMarker(planStep.id, "failed to start", resultStep.durationMs));
        this.markRemainingStepsSkipped(session, index + 1);
        this.finish(session, 1);
        return;
      }
      resultStep.durationMs = Date.now() - stepStartedAt;
      resultStep.exitCode = outcome.exitCode;
      resultStep.signal = outcome.signal;

      if (session.cancelRequested) {
        resultStep.status = "cancelled";
        this.append(session, stepEndMarker(planStep.id, "cancelled", resultStep.durationMs));
        this.markRemainingStepsSkipped(session, index + 1);
        this.finish(session, outcome.exitCode, outcome.signal);
        return;
      }

      if (outcome.signal || outcome.exitCode !== 0) {
        resultStep.status = "failed";
        const detail = outcome.signal
          ? `failed after signal ${outcome.signal}`
          : `failed with exit code ${outcome.exitCode ?? "unknown"}`;
        this.append(session, stepEndMarker(planStep.id, detail, resultStep.durationMs));
        this.markRemainingStepsSkipped(session, index + 1);
        this.finish(session, outcome.exitCode, outcome.signal);
        return;
      }

      resultStep.status = "completed";
      this.append(session, stepEndMarker(planStep.id, "completed", resultStep.durationMs));
    }

    this.finish(session, 0);
  }

  private runPlanStep(
    session: ProcessSession,
    input: StartActionPlanInput,
    step: WorkspaceActionPlanStep,
  ): Promise<{ exitCode?: number; signal?: string }> {
    if ("kind" in step && step.kind === "write_json") {
      return writeWorkspaceJsonArtifact(input.cwd, step.path, step.value).then(() => {
        const context = session.context;
        const artifact = input.plannedArtifacts?.find((candidate) => candidate.path === step.path);
        if (
          context?.kind === "workspace_action"
          && artifact
          && !context.artifacts.some((candidate) => candidate.path === artifact.path)
        ) {
          context.artifacts.push({ ...artifact });
        }
        this.append(session, `Generated artifact: ${step.path}\n`);
        return { exitCode: 0 };
      });
    }

    if ("kind" in step && step.kind === "process") {
      return this.runProcessPlanStep(session, input, step);
    }

    return new Promise((resolve, reject) => {
      const commandInput: StartCommandInput = {
        workspaceId: input.workspaceId,
        command: step.command,
        cwd: input.cwd,
        workspaceRoot: input.workspaceRoot,
        outputRedactions: input.outputRedactions,
        outputMode: input.outputMode,
        tty: input.tty,
        columns: session.columns,
        rows: session.rows,
      };

      try {
        if (input.tty && process.platform !== "win32") {
          void this.startPty(session, commandInput, (exitCode, signal) => {
            resolve({ exitCode, signal });
          }).catch(reject);
        } else {
          this.startPipe(session, commandInput, (exitCode, signal) => {
            resolve({ exitCode, signal });
          });
        }
      } catch (error) {
        reject(error);
      }
    });
  }

  private async runProcessPlanStep(
    session: ProcessSession,
    input: StartActionPlanInput,
    step: WorkspaceActionProcessStep,
  ): Promise<{ exitCode?: number; signal?: string }> {
    const childEnvironment = buildChildProcessEnvironment({
      workspaceId: input.workspaceId,
      workspaceRoot: input.workspaceRoot,
    });
    const executable = await resolveExecutablePath(step.executable, {
      cwd: input.cwd,
      env: childEnvironment,
    });
    if (!executable) throw new RequiredExecutableMissingError(step.executable);

    return new Promise((resolve, reject) => {
      try {
        if (input.tty && process.platform !== "win32") {
          void this.startProcessPty(
            session,
            input,
            executable,
            step.args,
            childEnvironment,
            (exitCode, signal) => resolve({ exitCode, signal }),
          ).catch(reject);
        } else {
          this.startProcessPipe(
            session,
            input,
            executable,
            step.args,
            childEnvironment,
            (exitCode, signal) => resolve({ exitCode, signal }),
          );
        }
      } catch (error) {
        reject(error);
      }
    });
  }

  private markRemainingStepsSkipped(session: ProcessSession, startIndex = 0): void {
    const context = session.context;
    if (context?.kind !== "workspace_action") return;
    for (let index = startIndex; index < context.steps.length; index++) {
      const step = context.steps[index];
      if (step?.status === "pending") step.status = "skipped";
    }
  }

  private startPipe(
    session: ProcessSession,
    input: StartCommandInput,
    onExit: (exitCode?: number, signal?: string) => void = (exitCode, signal) => {
      this.finish(session, exitCode, signal);
    },
  ): void {
    const shell = resolveShellCommand(input.command);
    const detached = process.platform !== "win32";
    const child = spawn(input.command, {
      cwd: input.cwd,
      env: buildChildProcessEnvironment({
        workspaceId: input.workspaceId,
        workspaceRoot: input.workspaceRoot,
      }),
      stdio: "pipe",
      windowsHide: true,
      detached,
      shell: shell.executable,
    });

    session.process = {
      write: (data) => child.stdin.write(data),
      kill: (signal = "SIGTERM") => terminateProcessTree(child, signal, detached),
      resize: input.tty ? () => undefined : undefined,
    };
    child.stdout.on("data", (data: Buffer) => this.append(session, data.toString("utf8")));
    child.stderr.on("data", (data: Buffer) => this.append(session, data.toString("utf8")));
    child.on("error", (error) => this.append(session, `${error.message}\n`));
    child.on("close", (code, signal) => onExit(code ?? undefined, signal ?? undefined));
  }

  private startProcessPipe(
    session: ProcessSession,
    input: StartActionPlanInput,
    executable: string,
    args: readonly string[],
    childEnvironment: NodeJS.ProcessEnv,
    onExit: (exitCode?: number, signal?: string) => void,
  ): void {
    const detached = process.platform !== "win32";
    const invocation = process.platform === "win32" && isWindowsCommandShim(executable)
      ? {
          executable: childEnvironment.ComSpec ?? process.env.ComSpec ?? "cmd.exe",
          args: ["/d", "/c", "call", executable, ...args],
        }
      : { executable, args: [...args] };
    const child = spawn(invocation.executable, invocation.args, {
      cwd: input.cwd,
      env: childEnvironment,
      stdio: "pipe",
      windowsHide: true,
      detached,
      shell: false,
    });

    session.process = {
      write: (data) => child.stdin.write(data),
      kill: (signal = "SIGTERM") => terminateProcessTree(child, signal, detached),
      resize: input.tty ? () => undefined : undefined,
    };
    child.stdout.on("data", (data: Buffer) => this.append(session, data.toString("utf8")));
    child.stderr.on("data", (data: Buffer) => this.append(session, data.toString("utf8")));
    let settled = false;
    const finish = (exitCode?: number, signal?: string): void => {
      if (settled) return;
      settled = true;
      onExit(exitCode, signal);
    };
    child.once("error", (error) => {
      this.append(session, `${error.message}\n`);
      finish(1);
    });
    child.once("close", (code, signal) => finish(code ?? undefined, signal ?? undefined));
  }

  private async startProcessPty(
    session: ProcessSession,
    input: StartActionPlanInput,
    executable: string,
    args: readonly string[],
    childEnvironment: NodeJS.ProcessEnv,
    onExit: (exitCode?: number, signal?: string) => void,
  ): Promise<void> {
    let nodePty: typeof import("node-pty");
    try {
      nodePty = await import("node-pty");
    } catch {
      throw new Error("PTY support requires the optional node-pty dependency.");
    }

    const pty = nodePty.spawn(executable, [...args], {
      cwd: input.cwd,
      env: childEnvironment,
      name: "xterm-256color",
      cols: session.columns,
      rows: session.rows,
    });
    session.process = {
      write: (data) => pty.write(data),
      kill: (signal) => pty.kill(signal),
      resize: (columns, rows) => pty.resize(columns, rows),
    };
    pty.onData((data) => this.append(session, data));
    pty.onExit(({ exitCode, signal }) => {
      onExit(exitCode, signal === 0 ? undefined : String(signal));
    });
  }

  private async startPty(
    session: ProcessSession,
    input: StartCommandInput,
    onExit: (exitCode?: number, signal?: string) => void = (exitCode, signal) => {
      this.finish(session, exitCode, signal);
    },
  ): Promise<void> {
    let nodePty: typeof import("node-pty");
    try {
      nodePty = await import("node-pty");
    } catch {
      throw new Error("PTY support requires the optional node-pty dependency.");
    }

    const shell = resolveShellCommand(input.command);
    let pty: import("node-pty").IPty;
    try {
      pty = nodePty.spawn(shell.executable, shell.args, {
        cwd: input.cwd,
        env: buildChildProcessEnvironment({
          workspaceId: input.workspaceId,
          workspaceRoot: input.workspaceRoot,
        }),
        name: "xterm-256color",
        cols: session.columns,
        rows: session.rows,
      });
    } catch (error) {
      throw error;
    }

    session.process = {
      write: (data) => pty.write(data),
      kill: (signal) => pty.kill(signal),
      resize: (columns, rows) => pty.resize(columns, rows),
    };
    pty.onData((data) => this.append(session, data));
    pty.onExit(({ exitCode, signal }) => {
      onExit(exitCode, signal === 0 ? undefined : String(signal));
    });
  }

  private finish(session: ProcessSession, exitCode?: number, signal?: string): void {
    if (!session.running) return;
    session.running = false;
    session.exitCode = exitCode;
    session.signal = signal;
    session.resolveExit();
    session.cleanupTimer = setTimeout(
      () => this.sessions.delete(session.id),
      this.completedSessionTtlMs,
    );
    session.cleanupTimer.unref();
  }

  private append(session: ProcessSession, output: string): void {
    if (session.outputMode === "status") return;
    this.onBufferAppend?.(output);
    session.buffer.append(output);
  }

  private consume(session: ProcessSession, maxOutputTokens?: number): ProcessSnapshot {
    const limit = boundedInteger(maxOutputTokens, DEFAULT_MAX_OUTPUT_TOKENS, 100_000);
    const maxCharacters = Math.max(256, limit * 4);
    const buffered = session.buffer.drain(maxCharacters);
    const outputSuppressed = session.outputMode === "status";

    return {
      sessionId: session.running ? session.id : undefined,
      output: outputSuppressed ? "" : redactPathsInText(buffered.output, session.outputRedactions),
      outputTruncated: outputSuppressed ? false : buffered.truncated,
      outputSuppressed: outputSuppressed || undefined,
      running: session.running,
      exitCode: session.exitCode,
      signal: session.signal,
      wallTimeMs: Date.now() - session.startedAt,
      cancelled: !session.running && session.cancelRequested ? true : undefined,
      context: session.context
        ? cloneProcessSessionContext(session.context)
        : undefined,
    };
  }

  private getOwnedSession(workspaceId: string, sessionId: number): ProcessSession {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Unknown process session: ${sessionId}`);
    if (session.workspaceId !== workspaceId) {
      throw new Error(`Process session ${sessionId} does not belong to workspace ${workspaceId}.`);
    }
    return session;
  }

  private removeSession(sessionId: number): void {
    const session = this.sessions.get(sessionId);
    if (session?.cleanupTimer) clearTimeout(session.cleanupTimer);
    this.sessions.delete(sessionId);
  }
}

function cloneProcessSessionContext(context: ProcessSessionContext): ProcessSessionContext {
  return {
    ...context,
    policy: [...context.policy],
    profileEvidence: [...context.profileEvidence],
    warnings: [...context.warnings],
    artifacts: context.artifacts.map((artifact) => ({ ...artifact })),
    steps: context.steps.map((step) => ({ ...step })),
  };
}

function singleLineStepText(value: string): string {
  return value.replace(/[\r\n]+/g, " ").trim();
}

function stepEndMarker(id: string, status: string, durationMs: number | undefined): string {
  return `<== [${singleLineStepText(id)}] ${status} in ${durationMs ?? 0}ms\n`;
}
