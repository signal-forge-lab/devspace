import { spawn } from "node:child_process";
import { buildChildProcessEnvironment } from "./child-environment.js";
import {
  isWindowsCommandShim,
  RequiredExecutableMissingError,
  resolveExecutablePath,
} from "./executable-resolution.js";
import { terminateProcessTree } from "./process-platform.js";
import type {
  WorkspaceActionArtifact,
  WorkspaceActionExecutionPlan,
  WorkspaceActionPlanStep,
  WorkspaceActionProcessStep,
  WorkspaceActionStepResult,
} from "./workspace-action-plans.js";
import { writeWorkspaceJsonArtifact } from "./workspace-json-artifact.js";

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

export interface WorkspaceActionProcessPlanInput {
  workspaceId: string;
  plan: WorkspaceActionExecutionPlan;
  plannedArtifacts?: WorkspaceActionArtifact[];
  cwd: string;
  workspaceRoot?: string;
  tty?: boolean;
  columns?: number;
  rows?: number;
  context: WorkspaceActionProcessContext;
}

interface WorkspaceActionManagedProcess {
  write(data: string): void;
  kill(signal?: NodeJS.Signals): void;
  resize?(columns: number, rows: number): void;
}

export interface WorkspaceActionProcessRuntime {
  isCancellationRequested(): boolean;
  append(output: string): void;
  attachProcess(process: WorkspaceActionManagedProcess): void;
  finish(exitCode?: number, signal?: string): void;
}

interface ProcessStepOutcome {
  exitCode?: number;
  signal?: string;
}

export async function runWorkspaceActionProcessPlan(
  input: WorkspaceActionProcessPlanInput,
  runtime: WorkspaceActionProcessRuntime,
): Promise<void> {
  try {
    if (input.context.kind !== "workspace_action") {
      throw new Error("Workspace action plan sessions require workspace action context.");
    }
    await runPlan(input, runtime);
  } catch (error) {
    runtime.append(`${error instanceof Error ? error.message : String(error)}\n`);
    markRemainingStepsSkipped(input.context);
    runtime.finish(1);
  }
}

export function cloneWorkspaceActionProcessContext(
  context: WorkspaceActionProcessContext,
): WorkspaceActionProcessContext {
  return {
    ...context,
    policy: [...context.policy],
    profileEvidence: [...context.profileEvidence],
    warnings: [...context.warnings],
    artifacts: context.artifacts.map((artifact) => ({ ...artifact })),
    steps: context.steps.map((step) => ({ ...step })),
  };
}

async function runPlan(
  input: WorkspaceActionProcessPlanInput,
  runtime: WorkspaceActionProcessRuntime,
): Promise<void> {
  const { context } = input;

  for (let index = 0; index < input.plan.steps.length; index++) {
    const planStep = input.plan.steps[index];
    const resultStep = context.steps[index];
    if (!planStep || !resultStep) {
      throw new Error("Workspace action plan and result steps are out of sync.");
    }

    if (runtime.isCancellationRequested()) {
      resultStep.status = "skipped";
      continue;
    }

    resultStep.status = "running";
    runtime.append(
      `==> [${singleLineStepText(planStep.id)}] ${singleLineStepText(planStep.label)}\n`,
    );
    const stepStartedAt = Date.now();
    let outcome: ProcessStepOutcome;
    try {
      outcome = await runPlanStep(input, runtime, planStep);
    } catch (error) {
      resultStep.durationMs = Date.now() - stepStartedAt;
      resultStep.exitCode = 1;
      resultStep.status = "failed";
      runtime.append(`${error instanceof Error ? error.message : String(error)}\n`);
      runtime.append(stepEndMarker(planStep.id, "failed to start", resultStep.durationMs));
      markRemainingStepsSkipped(context, index + 1);
      runtime.finish(1);
      return;
    }
    resultStep.durationMs = Date.now() - stepStartedAt;
    resultStep.exitCode = outcome.exitCode;
    resultStep.signal = outcome.signal;

    if (runtime.isCancellationRequested()) {
      resultStep.status = "cancelled";
      runtime.append(stepEndMarker(planStep.id, "cancelled", resultStep.durationMs));
      markRemainingStepsSkipped(context, index + 1);
      runtime.finish(outcome.exitCode, outcome.signal);
      return;
    }

    if (outcome.signal || outcome.exitCode !== 0) {
      resultStep.status = "failed";
      const detail = outcome.signal
        ? `failed after signal ${outcome.signal}`
        : `failed with exit code ${outcome.exitCode ?? "unknown"}`;
      runtime.append(stepEndMarker(planStep.id, detail, resultStep.durationMs));
      markRemainingStepsSkipped(context, index + 1);
      runtime.finish(outcome.exitCode, outcome.signal);
      return;
    }

    resultStep.status = "completed";
    runtime.append(stepEndMarker(planStep.id, "completed", resultStep.durationMs));
  }

  runtime.finish(0);
}

function runPlanStep(
  input: WorkspaceActionProcessPlanInput,
  runtime: WorkspaceActionProcessRuntime,
  step: WorkspaceActionPlanStep,
): Promise<ProcessStepOutcome> {
  if (step.kind === "write_json") {
    return writeWorkspaceJsonArtifact(input.cwd, step.path, step.value).then(() => {
      const artifact = input.plannedArtifacts?.find((candidate) => candidate.path === step.path);
      if (
        artifact
        && !input.context.artifacts.some((candidate) => candidate.path === artifact.path)
      ) {
        input.context.artifacts.push({ ...artifact });
      }
      runtime.append(`Generated artifact: ${step.path}\n`);
      return { exitCode: 0 };
    });
  }

  return runProcessPlanStep(input, runtime, step);
}

async function runProcessPlanStep(
  input: WorkspaceActionProcessPlanInput,
  runtime: WorkspaceActionProcessRuntime,
  step: WorkspaceActionProcessStep,
): Promise<ProcessStepOutcome> {
  const childEnvironment = buildChildProcessEnvironment({
    workspaceId: input.workspaceId,
    workspaceRoot: input.workspaceRoot,
  });
  const executable = await resolveExecutablePath(step.executable, {
    cwd: input.cwd,
    env: childEnvironment,
  });
  if (!executable) throw new RequiredExecutableMissingError(step.executable);

  if (input.tty && process.platform !== "win32") {
    return startProcessPty(input, runtime, executable, step.args, childEnvironment);
  }
  return startProcessPipe(input, runtime, executable, step.args, childEnvironment);
}

function startProcessPipe(
  input: WorkspaceActionProcessPlanInput,
  runtime: WorkspaceActionProcessRuntime,
  executable: string,
  args: readonly string[],
  childEnvironment: NodeJS.ProcessEnv,
): Promise<ProcessStepOutcome> {
  return new Promise((resolve) => {
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

    runtime.attachProcess({
      write: (data) => child.stdin.write(data),
      kill: (signal = "SIGTERM") => terminateProcessTree(child, signal, detached),
      resize: input.tty ? () => undefined : undefined,
    });
    child.stdout.on("data", (data: Buffer) => runtime.append(data.toString("utf8")));
    child.stderr.on("data", (data: Buffer) => runtime.append(data.toString("utf8")));
    let settled = false;
    const finish = (outcome: ProcessStepOutcome): void => {
      if (settled) return;
      settled = true;
      resolve(outcome);
    };
    child.once("error", (error) => {
      runtime.append(`${error.message}\n`);
      finish({ exitCode: 1 });
    });
    child.once("close", (code, signal) => finish({
      exitCode: code ?? undefined,
      signal: signal ?? undefined,
    }));
  });
}

async function startProcessPty(
  input: WorkspaceActionProcessPlanInput,
  runtime: WorkspaceActionProcessRuntime,
  executable: string,
  args: readonly string[],
  childEnvironment: NodeJS.ProcessEnv,
): Promise<ProcessStepOutcome> {
  let nodePty: typeof import("node-pty");
  try {
    nodePty = await import("node-pty");
  } catch {
    throw new Error("PTY support requires the optional node-pty dependency.");
  }

  return new Promise((resolve) => {
    const pty = nodePty.spawn(executable, [...args], {
      cwd: input.cwd,
      env: childEnvironment,
      name: "xterm-256color",
      cols: input.columns ?? 80,
      rows: input.rows ?? 24,
    });
    runtime.attachProcess({
      write: (data) => pty.write(data),
      kill: (signal) => pty.kill(signal),
      resize: (columns, rows) => pty.resize(columns, rows),
    });
    pty.onData((data) => runtime.append(data));
    pty.onExit(({ exitCode, signal }) => {
      resolve({ exitCode, signal: signal === 0 ? undefined : String(signal) });
    });
  });
}

function markRemainingStepsSkipped(
  context: WorkspaceActionProcessContext,
  startIndex = 0,
): void {
  for (let index = startIndex; index < context.steps.length; index++) {
    const step = context.steps[index];
    if (step?.status === "pending") step.status = "skipped";
  }
}

function singleLineStepText(value: string): string {
  return value.replace(/[\r\n]+/g, " ").trim();
}

function stepEndMarker(id: string, status: string, durationMs: number | undefined): string {
  return `<== [${singleLineStepText(id)}] ${status} in ${durationMs ?? 0}ms\n`;
}
