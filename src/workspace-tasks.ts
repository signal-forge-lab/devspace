import { access } from "node:fs/promises";
import { resolve } from "node:path";

export const WORKSPACE_TASK_NAMES = ["aegis_runner"] as const;
export type WorkspaceTaskName = (typeof WORKSPACE_TASK_NAMES)[number];

export interface ResolveWorkspaceTaskInput {
  workspaceRoot: string;
  task: string;
  args?: string[];
  template?: string;
  pythonCommand?: string;
}

export interface ResolvedWorkspaceTask {
  task: WorkspaceTaskName;
  template?: string;
  executable: string;
  args: string[];
  command: string;
  scriptPath: string;
}

interface WorkspaceTaskDefinition {
  runtime: "python";
  script: string;
  defaultArgs: string[];
  templates: Record<string, string[]>;
}

const WORKSPACE_TASKS: Record<WorkspaceTaskName, WorkspaceTaskDefinition> = {
  aegis_runner: {
    runtime: "python",
    script: "aegis_runner.py",
    defaultArgs: ["-X", "utf8"],
    templates: {
      status_console_5s: ["--launch-status-console", "--status-console-refresh-seconds", "5"],
    },
  },
};

export function isWorkspaceTaskName(task: string): task is WorkspaceTaskName {
  return (WORKSPACE_TASK_NAMES as readonly string[]).includes(task);
}

export function workspaceTaskTemplateNames(task: string): string[] {
  if (!isWorkspaceTaskName(task)) return [];
  return Object.keys(WORKSPACE_TASKS[task].templates);
}

export async function resolveWorkspaceTask(input: ResolveWorkspaceTaskInput): Promise<ResolvedWorkspaceTask> {
  if (!isWorkspaceTaskName(input.task)) {
    throw new Error(`Unsupported workspace task: ${input.task}. Allowed tasks: ${WORKSPACE_TASK_NAMES.join(", ")}`);
  }

  const definition = WORKSPACE_TASKS[input.task];
  const scriptPath = resolve(input.workspaceRoot, definition.script);
  await access(scriptPath);

  const templateArgs = input.template ? definition.templates[input.template] : [];
  if (input.template && !templateArgs) {
    throw new Error(
      `Unsupported template for ${input.task}: ${input.template}. Allowed templates: ${workspaceTaskTemplateNames(input.task).join(", ")}`,
    );
  }

  const executable = input.pythonCommand?.trim() || process.env.DEVSPACE_PYTHON_COMMAND?.trim() || "python";
  const args = [...definition.defaultArgs, scriptPath, ...(templateArgs ?? []), ...(input.args ?? [])];
  return {
    task: input.task,
    template: input.template,
    executable,
    args,
    command: commandPreview([executable, ...args]),
    scriptPath,
  };
}

function commandPreview(parts: string[]): string {
  return parts.map(quoteArg).join(" ");
}

function quoteArg(value: string): string {
  if (/^[A-Za-z0-9_./:=@\\-]+$/.test(value)) return value;
  return JSON.stringify(value);
}
