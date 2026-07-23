export interface WorkspaceActionStep {
  id: string;
  label: string;
  command: string;
}

export interface WorkspaceActionExecutionPlan {
  kind: "shell_steps";
  steps: WorkspaceActionStep[];
}

export function shellSteps(
  steps: readonly WorkspaceActionStep[],
): WorkspaceActionExecutionPlan {
  if (steps.length === 0) {
    throw new Error("Workspace action plans must contain at least one step.");
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
  return plan.steps.map((step) => step.command).join(" && ");
}
