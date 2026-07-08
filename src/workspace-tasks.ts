import { access, readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

const DEFAULT_WORKSPACE_TASK_CONFIG_PATH = ".workbridge/workspace-tasks.json";

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
  displayCommand: string;
  scriptPath: string;
}

interface WorkspaceTaskDefinition {
  runtime: "python";
  script: string;
  defaultArgs: string[];
  description: string;
  templates: Record<string, WorkspaceTaskTemplateDefinition>;
}

interface WorkspaceTaskTemplateDefinition {
  args: string[];
  description: string;
  source?: "config";
}

export interface WorkspaceTaskTemplateIssue {
  task?: string;
  template?: string;
  reason: string;
}

export interface WorkspaceTaskTemplateConfigSummary {
  path: string;
  loaded: boolean;
  issues: WorkspaceTaskTemplateIssue[];
}

export interface WorkspaceTaskCatalogEntry {
  name: WorkspaceTaskName;
  runtime: "python";
  script: string;
  scriptPresent: boolean;
  defaultArgs: string[];
  templates: Array<{ name: string; args: string[]; description: string; source?: "config" }>;
  templateConfig: WorkspaceTaskTemplateConfigSummary;
  examples: Array<{ description: string; payload: Record<string, unknown> }>;
  description: string;
}

const WORKSPACE_TASKS: Record<WorkspaceTaskName, WorkspaceTaskDefinition> = {
  aegis_runner: {
    runtime: "python",
    script: "aegis_runner.py",
    description: "Aegis runner local control entrypoint.",
    defaultArgs: ["-X", "utf8"],
    templates: {},
  },
};

export function isWorkspaceTaskName(task: string): task is WorkspaceTaskName {
  return (WORKSPACE_TASK_NAMES as readonly string[]).includes(task);
}

interface WorkspaceTaskConfigLoadResult extends WorkspaceTaskTemplateConfigSummary {
  templates: Partial<Record<WorkspaceTaskName, Record<string, WorkspaceTaskTemplateDefinition>>>;
}

let centralWorkspaceTaskConfigPromise: Promise<WorkspaceTaskConfigLoadResult> | undefined;

export function initializeWorkspaceTaskConfig(): Promise<WorkspaceTaskConfigLoadResult> {
  centralWorkspaceTaskConfigPromise ??= loadWorkspaceTaskConfig(
    workspaceTaskConfigAbsolutePath(),
    workspaceTaskConfigPathIsExplicit(),
  );
  return centralWorkspaceTaskConfigPromise;
}

export function resetWorkspaceTaskConfigForTest(): void {
  centralWorkspaceTaskConfigPromise = undefined;
}

export async function workspaceTaskCatalog(workspaceRoot: string): Promise<WorkspaceTaskCatalogEntry[]> {
  const config = await workspaceTaskConfigForRoot(workspaceRoot);
  return Promise.all(
    WORKSPACE_TASK_NAMES.map(async (name) => {
      const definition = await workspaceTaskDefinitionForRoot(workspaceRoot, name);
      const scriptPath = resolve(workspaceRoot, definition.script);
      const scriptPresent = await pathExists(scriptPath);
      const templates = Object.entries(definition.templates).map(([templateName, template]) => ({
        name: templateName,
        args: template.args,
        description: template.description,
        source: template.source,
      }));

      return {
        name,
        runtime: definition.runtime,
        script: definition.script,
        scriptPresent,
        defaultArgs: definition.defaultArgs,
        templates,
        templateConfig: {
          path: config.path,
          loaded: config.loaded,
          issues: config.issues,
        },
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

  const definition = await workspaceTaskDefinitionForRoot(input.workspaceRoot, input.task);
  const scriptPath = resolve(input.workspaceRoot, definition.script);
  await access(scriptPath);

  const template = input.template ? definition.templates[input.template] : undefined;
  if (input.template && !template) {
    throw new Error(
      `Unsupported template for ${input.task}: ${input.template}. Allowed templates: ${Object.keys(definition.templates).join(", ")}`,
    );
  }

  const executable = input.pythonCommand?.trim() || process.env.DEVSPACE_PYTHON_COMMAND?.trim() || "python";
  const templateArgs = template?.args ?? [];
  const explicitArgs = input.args ?? [];
  const args = [...definition.defaultArgs, scriptPath, ...templateArgs, ...explicitArgs];
  const displayScriptPath = `<workspace>/${definition.script.replace(/\\/g, "/")}`;
  const displayArgs = [...definition.defaultArgs, displayScriptPath, ...templateArgs, ...explicitArgs];
  return {
    task: input.task,
    template: input.template,
    executable,
    args,
    command: commandPreview([executable, ...args]),
    displayCommand: commandPreview([executable, ...displayArgs]),
    scriptPath,
  };
}

async function workspaceTaskDefinitionForRoot(
  workspaceRoot: string,
  task: WorkspaceTaskName,
): Promise<WorkspaceTaskDefinition> {
  const config = await workspaceTaskConfigForRoot(workspaceRoot);
  const definition = cloneWorkspaceTaskDefinition(WORKSPACE_TASKS[task]);
  const externalTemplates = config.templates[task] ?? {};
  for (const [name, template] of Object.entries(externalTemplates)) {
    definition.templates[name] = template;
  }
  return definition;
}

function cloneWorkspaceTaskDefinition(definition: WorkspaceTaskDefinition): WorkspaceTaskDefinition {
  return {
    runtime: definition.runtime,
    script: definition.script,
    defaultArgs: [...definition.defaultArgs],
    description: definition.description,
    templates: Object.fromEntries(
      Object.entries(definition.templates).map(([name, template]) => [
        name,
        { args: [...template.args], description: template.description, source: template.source },
      ]),
    ),
  };
}

async function workspaceTaskConfigForRoot(workspaceRoot: string): Promise<WorkspaceTaskConfigLoadResult> {
  const centralConfig = await initializeWorkspaceTaskConfig();
  const localPath = resolve(workspaceRoot, DEFAULT_WORKSPACE_TASK_CONFIG_PATH);
  if (samePath(localPath, centralConfig.path)) return centralConfig;

  const localConfig = await loadWorkspaceTaskConfig(localPath, false);
  return mergeWorkspaceTaskConfigs(centralConfig, localConfig);
}

async function loadWorkspaceTaskConfig(configPath: string, reportMissing: boolean): Promise<WorkspaceTaskConfigLoadResult> {
  const result: WorkspaceTaskConfigLoadResult = {
    path: configPath,
    loaded: false,
    issues: [],
    templates: {},
  };

  let raw: string;
  try {
    raw = await readFile(configPath, "utf8");
  } catch {
    if (reportMissing) result.issues.push({ reason: `Config file not found: ${configPath}` });
    return result;
  }

  result.loaded = true;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (error) {
    result.issues.push({ reason: `Invalid JSON: ${error instanceof Error ? error.message : String(error)}` });
    return result;
  }

  if (!isRecord(parsed) || !isRecord(parsed.tasks)) {
    result.issues.push({ reason: "Config must contain a tasks object." });
    return result;
  }

  for (const [taskName, taskValue] of Object.entries(parsed.tasks)) {
    if (!isWorkspaceTaskName(taskName)) {
      result.issues.push({ task: taskName, reason: `Unsupported workspace task: ${taskName}.` });
      continue;
    }
    if (!isRecord(taskValue) || !isRecord(taskValue.templates)) {
      result.issues.push({ task: taskName, reason: "Task entry must contain a templates object." });
      continue;
    }

    for (const [templateName, templateValue] of Object.entries(taskValue.templates)) {
      const issueBase = { task: taskName, template: templateName };
      if (!validTemplateName(templateName)) {
        result.issues.push({ ...issueBase, reason: "Template name must use letters, numbers, underscores, or hyphens, and be 1-64 characters." });
        continue;
      }
      const template = parseWorkspaceTemplate(templateValue);
      if ("reason" in template) {
        result.issues.push({ ...issueBase, reason: template.reason });
        continue;
      }
      result.templates[taskName] ??= {};
      result.templates[taskName][templateName] = template;
    }
  }

  return result;
}

function mergeWorkspaceTaskConfigs(
  centralConfig: WorkspaceTaskConfigLoadResult,
  localConfig: WorkspaceTaskConfigLoadResult,
): WorkspaceTaskConfigLoadResult {
  const merged: WorkspaceTaskConfigLoadResult = {
    path: localConfig.loaded ? `${centralConfig.path}; ${localConfig.path}` : centralConfig.path,
    loaded: centralConfig.loaded || localConfig.loaded,
    issues: [...centralConfig.issues, ...localConfig.issues],
    templates: cloneWorkspaceTaskTemplates(centralConfig.templates),
  };

  for (const [taskName, templates] of Object.entries(localConfig.templates)) {
    if (!isWorkspaceTaskName(taskName)) continue;
    merged.templates[taskName] ??= {};
    for (const [templateName, template] of Object.entries(templates)) {
      if (merged.templates[taskName]?.[templateName]) {
        merged.issues.push({ task: taskName, template: templateName, reason: "Workspace-local template overrides are not allowed." });
        continue;
      }
      merged.templates[taskName][templateName] = template;
    }
  }

  return merged;
}

function cloneWorkspaceTaskTemplates(
  templates: Partial<Record<WorkspaceTaskName, Record<string, WorkspaceTaskTemplateDefinition>>>,
): Partial<Record<WorkspaceTaskName, Record<string, WorkspaceTaskTemplateDefinition>>> {
  const cloned: Partial<Record<WorkspaceTaskName, Record<string, WorkspaceTaskTemplateDefinition>>> = {};
  for (const [taskName, taskTemplates] of Object.entries(templates)) {
    if (!isWorkspaceTaskName(taskName)) continue;
    cloned[taskName] = Object.fromEntries(
      Object.entries(taskTemplates).map(([name, template]) => [
        name,
        { args: [...template.args], description: template.description, source: template.source },
      ]),
    );
  }
  return cloned;
}

function workspaceTaskConfigAbsolutePath(): string {
  const configuredPath = workspaceTaskConfigPath();
  return isAbsolute(configuredPath) ? configuredPath : resolve(process.cwd(), configuredPath);
}

function workspaceTaskConfigPath(): string {
  return process.env.WORKBRIDGE_WORKSPACE_TASKS_CONFIG?.trim()
    || process.env.DEVSPACE_WORKSPACE_TASKS_CONFIG?.trim()
    || DEFAULT_WORKSPACE_TASK_CONFIG_PATH;
}

function workspaceTaskConfigPathIsExplicit(): boolean {
  return Boolean(process.env.WORKBRIDGE_WORKSPACE_TASKS_CONFIG?.trim() || process.env.DEVSPACE_WORKSPACE_TASKS_CONFIG?.trim());
}

function parseWorkspaceTemplate(value: unknown): WorkspaceTaskTemplateDefinition | { reason: string } {
  if (!isRecord(value)) return { reason: "Template entry must be an object." };
  if (!Array.isArray(value.args)) return { reason: "Template args must be an array of strings." };
  if (value.args.length > 64) return { reason: "Template args must contain at most 64 items." };

  const args: string[] = [];
  for (const arg of value.args) {
    if (typeof arg !== "string") return { reason: "Template args must be strings." };
    if (arg.length > 500) return { reason: "Template args must be 500 characters or less." };
    if (/[\u0000-\u001f\u007f]/.test(arg)) return { reason: "Template args must not contain control characters." };
    args.push(arg);
  }

  const description = typeof value.description === "string" && value.description.trim().length > 0
    ? value.description.trim().slice(0, 240)
    : "Workspace-defined task template.";

  return { args, description, source: "config" };
}

function commandPreview(parts: string[]): string {
  return parts.map(quoteArg).join(" ");
}

function quoteArg(value: string): string {
  if (/^[A-Za-z0-9_./:=@\\-]+$/.test(value)) return value;
  return JSON.stringify(value);
}

function samePath(left: string, right: string): boolean {
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validTemplateName(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(value);
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
