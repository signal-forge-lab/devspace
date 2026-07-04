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
  description: string;
  templates: Record<string, { args: string[]; description: string }>;
}

export interface WorkspaceTaskCatalogEntry {
  name: WorkspaceTaskName;
  runtime: "python";
  script: string;
  scriptPresent: boolean;
  defaultArgs: string[];
  templates: Array<{ name: string; args: string[]; description: string }>;
  examples: Array<{ description: string; payload: Record<string, unknown> }>;
  description: string;
}

const WORKSPACE_TASKS: Record<WorkspaceTaskName, WorkspaceTaskDefinition> = {
  aegis_runner: {
    runtime: "python",
    script: "aegis_runner.py",
    description: "Aegis runner local control entrypoint.",
    defaultArgs: ["-X", "utf8"],
    templates: {
      status_console_5s: {
        args: ["--launch-status-console", "--status-console-refresh-seconds", "5"],
        description: "Launch the Aegis status console with 5-second refresh.",
      },
      daemon_confirm_post: {
        args: ["--daemon", "--confirm-post"],
        description: "Run Aegis Runner daemon with post confirmation enabled.",
      },
      daemon_confirm_post_bounded_10m: {
        args: [
          "--daemon",
          "--confirm-post",
          "--daemon-max-runtime-seconds",
          "600",
          "--daemon-poll-seconds",
          "10",
          "--daemon-heartbeat-seconds",
          "10",
        ],
        description: "Run Aegis Runner daemon for a bounded 10-minute smoke check.",
      },
      request_pause: {
        args: ["--request-pause"],
        description: "Request Aegis Runner to pause at the next safe boundary.",
      },
      resume_daemon: {
        args: ["--resume-daemon"],
        description: "Clear pause state before resuming daemon operation.",
      },
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

export async function workspaceTaskCatalog(workspaceRoot: string): Promise<WorkspaceTaskCatalogEntry[]> {
  return Promise.all(
    WORKSPACE_TASK_NAMES.map(async (name) => {
      const definition = WORKSPACE_TASKS[name];
      const scriptPath = resolve(workspaceRoot, definition.script);
      const scriptPresent = await pathExists(scriptPath);
      const templates = Object.entries(definition.templates).map(([templateName, template]) => ({
        name: templateName,
        args: template.args,
        description: template.description,
      }));
      return {
        name,
        runtime: definition.runtime,
        script: definition.script,
        scriptPresent,
        defaultArgs: definition.defaultArgs,
        templates,
        examples: [
          {
            description: "Launch a common template.",
            payload: { task: name, template: templates[0]?.name, tty: true, yieldTimeMs: 1000 },
          },
          {
            description: "Launch with explicit CLI args.",
            payload: { task: name, args: templates[0]?.args ?? [], tty: true, yieldTimeMs: 1000 },
          },
        ],
        description: definition.description,
      };
    }),
  );
}

export async function resolveWorkspaceTask(input: ResolveWorkspaceTaskInput): Promise<ResolvedWorkspaceTask> {
  if (!isWorkspaceTaskName(input.task)) {
    throw new Error(`Unsupported workspace task: ${input.task}. Allowed tasks: ${WORKSPACE_TASK_NAMES.join(", ")}`);
  }

  const definition = WORKSPACE_TASKS[input.task];
  const scriptPath = resolve(input.workspaceRoot, definition.script);
  await access(scriptPath);

  const template = input.template ? definition.templates[input.template] : undefined;
  if (input.template && !template) {
    throw new Error(
      `Unsupported template for ${input.task}: ${input.template}. Allowed templates: ${workspaceTaskTemplateNames(input.task).join(", ")}`,
    );
  }

  const executable = input.pythonCommand?.trim() || process.env.DEVSPACE_PYTHON_COMMAND?.trim() || "python";
  const args = [...definition.defaultArgs, scriptPath, ...(template?.args ?? []), ...(input.args ?? [])];
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

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
