export interface WorkspaceActionStep {
  id: string;
  label: string;
  command: string;
}

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
  kind: "shell_steps";
  steps: WorkspaceActionStep[];
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

export function shellSteps(
  steps: readonly WorkspaceActionStep[],
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
    const command = step.command.trim();
    if (!id || !label || !command) {
      throw new Error("Workspace action steps require non-empty id, label, and command fields.");
    }
    if (ids.has(id)) {
      throw new Error(`Duplicate workspace action step id: ${id}`);
    }
    ids.add(id);
    return { id, label, command };
  });

  return { kind: "shell_steps", steps: normalized };
}

export function compileWorkspaceActionPlan(
  plan: WorkspaceActionExecutionPlan,
): string {
  const command = plan.steps.map((step) => step.command).join(" && ");
  if (command.length > MAX_WORKSPACE_ACTION_COMMAND_PREVIEW_CHARACTERS) {
    throw new WorkspaceActionPlanResolutionError(
      `Workspace action command preview contains ${command.length} characters; the maximum is ${MAX_WORKSPACE_ACTION_COMMAND_PREVIEW_CHARACTERS}.`,
    );
  }
  return command;
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
