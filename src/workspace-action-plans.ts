export interface WorkspaceActionProcessStep {
  id: string;
  label: string;
  kind: "process";
  executable: string;
  args: string[];
}

export interface WorkspaceActionWriteJsonStep {
  id: string;
  label: string;
  kind: "write_json";
  path: string;
  value: unknown;
}

export type WorkspaceActionPlanStep =
  | WorkspaceActionProcessStep
  | WorkspaceActionWriteJsonStep;

export const WORKSPACE_ACTION_STEP_STATUSES = [
  "pending",
  "running",
  "completed",
  "failed",
  "cancelled",
  "skipped",
] as const;

export type WorkspaceActionStepStatus =
  (typeof WORKSPACE_ACTION_STEP_STATUSES)[number];

export interface WorkspaceActionStepResult {
  id: string;
  label: string;
  status: WorkspaceActionStepStatus;
  exitCode?: number;
  signal?: string;
  durationMs?: number;
}

export interface WorkspaceActionArtifact {
  path: string;
  kind: "file" | "directory" | "report";
  description?: string;
}

export interface WorkspaceActionExecutionPlan {
  kind: "steps";
  steps: WorkspaceActionPlanStep[];
}

export const MAX_WORKSPACE_ACTION_STEPS = 100;
export const MAX_WORKSPACE_ACTION_COMMAND_PREVIEW_CHARACTERS = 20_000;

export class WorkspaceActionPlanResolutionError extends Error {
  readonly kind = "action_plan_too_large" as const;

  constructor(message: string) {
    super(message);
    this.name = "WorkspaceActionPlanResolutionError";
  }
}

export function workspaceActionSteps(
  steps: readonly WorkspaceActionPlanStep[],
): WorkspaceActionExecutionPlan {
  if (steps.length === 0) {
    throw new Error("Workspace action plans must contain at least one step.");
  }
  if (steps.length > MAX_WORKSPACE_ACTION_STEPS) {
    throw new WorkspaceActionPlanResolutionError(
      `Workspace action plan contains ${steps.length} steps; the maximum is ${MAX_WORKSPACE_ACTION_STEPS}.`,
    );
  }

  const ids = new Set<string>();
  const normalized = steps.map((step) => {
    const id = step.id.trim();
    const label = step.label.trim();
    if (!id || !label) {
      throw new Error("Workspace action steps require non-empty id and label fields.");
    }
    if (ids.has(id)) {
      throw new Error(`Duplicate workspace action step id: ${id}`);
    }
    ids.add(id);

    if (step.kind === "process") {
      const executable = step.executable.trim();
      if (!executable) {
        throw new Error("Workspace action process steps require a non-empty executable.");
      }
      if (step.args.some((argument) => argument.includes("\u0000"))) {
        throw new Error("Workspace action process arguments must not contain NUL characters.");
      }
      return { id, label, kind: "process" as const, executable, args: [...step.args] };
    }

    const path = step.path.trim();
    if (!path) {
      throw new Error("Workspace action write_json steps require a non-empty path.");
    }
    return { id, label, kind: "write_json" as const, path, value: step.value };
  });

  return { kind: "steps", steps: normalized };
}

export function compileWorkspaceActionPlan(
  plan: WorkspaceActionExecutionPlan,
): string {
  const command = plan.steps.map(workspaceActionStepPreview).join(" && ");
  if (command.length > MAX_WORKSPACE_ACTION_COMMAND_PREVIEW_CHARACTERS) {
    throw new WorkspaceActionPlanResolutionError(
      `Workspace action command preview contains ${command.length} characters; the maximum is ${MAX_WORKSPACE_ACTION_COMMAND_PREVIEW_CHARACTERS}.`,
    );
  }
  return command;
}

export function processStep(
  id: string,
  label: string,
  executable: string,
  args: readonly string[] = [],
): WorkspaceActionProcessStep {
  return { id, label, kind: "process", executable, args: [...args] };
}

export function writeJsonStep(
  id: string,
  label: string,
  path: string,
  value: unknown,
): WorkspaceActionWriteJsonStep {
  return { id, label, kind: "write_json", path, value };
}

export function workspaceActionStepPreview(step: WorkspaceActionPlanStep): string {
  if (step.kind === "process") {
    return [step.executable, ...step.args].map(displayArgument).join(" ");
  }
  return `write-json ${displayArgument(step.path)}`;
}

export function pendingWorkspaceActionSteps(
  plan: WorkspaceActionExecutionPlan,
): WorkspaceActionStepResult[] {
  return plan.steps.map((step) => ({
    id: step.id,
    label: step.label,
    status: "pending",
  }));
}

function displayArgument(value: string): string {
  if (/^[A-Za-z0-9_./:@+-]+$/.test(value)) return value;
  return JSON.stringify(value);
}
