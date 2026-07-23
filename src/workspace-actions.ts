import {
  ProjectProfileResolutionError,
  resolveProjectVerifyProfile,
  type ProjectProfileName,
} from "./project-profiles.js";
import {
  compileWorkspaceActionPlan,
  shellSteps,
  type WorkspaceActionExecutionPlan,
} from "./workspace-action-plans.js";

export const WORKSPACE_ACTION_NAMES = [
  "workspace_verify",
  "workspace_review",
  "project_verify",
] as const;
export type WorkspaceActionName = (typeof WORKSPACE_ACTION_NAMES)[number];

export const WORKSPACE_ACTION_POLICIES = [
  "read_only",
  "workspace_modify",
  "git_modify",
  "external_effect",
  "long_running",
] as const;
export type WorkspaceActionPolicy = (typeof WORKSPACE_ACTION_POLICIES)[number];

export interface ResolveWorkspaceActionInput {
  workspaceRoot: string;
  action: string;
  preset?: string;
  parameters?: Record<string, unknown>;
}

export type WorkspaceActionResolutionErrorKind =
  | "unsupported_action"
  | "unsupported_preset"
  | "invalid_parameters"
  | "unsupported_project_profile"
  | "unsupported_action_for_profile"
  | "invalid_project_manifest"
  | "invalid_extension_manifest"
  | "missing_extension_resource"
  | "ambiguous_project_profile"
  | "ambiguous_python_runner"
  | "unsupported_package_manager"
  | "ambiguous_package_manager";

export class WorkspaceActionResolutionError extends Error {
  readonly kind: WorkspaceActionResolutionErrorKind;
  readonly requestedAction: string;
  readonly requestedPreset?: string;
  readonly catalog: ReturnType<typeof workspaceActionCatalog>;

  constructor(input: {
    kind: WorkspaceActionResolutionErrorKind;
    message: string;
    requestedAction: string;
    requestedPreset?: string;
  }) {
    super(input.message);
    this.name = "WorkspaceActionResolutionError";
    this.kind = input.kind;
    this.requestedAction = input.requestedAction;
    this.requestedPreset = input.requestedPreset;
    this.catalog = workspaceActionCatalog();
  }
}

export interface ResolvedWorkspaceAction {
  action: WorkspaceActionName;
  preset: string;
  parameters: Record<string, unknown>;
  executable: "shell";
  args: [];
  command: string;
  displayCommand: string;
  description: string;
  policy: WorkspaceActionPolicy[];
  profile?: ProjectProfileName;
  plan: WorkspaceActionExecutionPlan;
}

interface WorkspaceActionPresetDefinition {
  description: string;
  plan?: WorkspaceActionExecutionPlan;
  validateParameters(parameters: Record<string, unknown>): void;
}

interface WorkspaceActionDefinition {
  description: string;
  defaultPreset: string;
  policy: WorkspaceActionPolicy[];
  presets: Record<string, WorkspaceActionPresetDefinition>;
}

const EMPTY_PARAMETERS: Record<string, unknown> = Object.freeze({});

const WORKSPACE_ACTIONS: Record<WorkspaceActionName, WorkspaceActionDefinition> = {
  workspace_verify: {
    description: "Run the fixed standard verification sequence for the Workbridge workspace.",
    defaultPreset: "standard",
    policy: ["workspace_modify", "long_running"],
    presets: {
      standard: {
        description: "Run typecheck, tool-schema baseline validation, tests, build, diff validation, and status.",
        plan: shellSteps([
          { id: "typecheck", label: "TypeScript typecheck", command: "npm run typecheck" },
          { id: "tool-contract", label: "Tool contract baseline", command: "npm run baseline:tools:check" },
          { id: "tests", label: "Test suite", command: "npm test" },
          { id: "build", label: "Production build", command: "npm run build" },
          { id: "diff-check", label: "Git diff validation", command: "git diff --check" },
          { id: "status", label: "Git status", command: "git status --short" },
        ]),
        validateParameters: requireNoParameters,
      },
    },
  },
  workspace_review: {
    description: "Inspect current Git changes without modifying the workspace.",
    defaultPreset: "summary",
    policy: ["read_only"],
    presets: {
      summary: {
        description: "Show concise working-tree status plus unstaged and staged diff statistics.",
        plan: shellSteps([
          { id: "status", label: "Git status", command: "git status --short" },
          { id: "unstaged-stat", label: "Unstaged diff statistics", command: "git diff --stat" },
          { id: "staged-stat", label: "Staged diff statistics", command: "git diff --cached --stat" },
        ]),
        validateParameters: requireNoParameters,
      },
      integrity: {
        description: "Validate diff whitespace and show concise working-tree status.",
        plan: shellSteps([
          { id: "diff-check", label: "Git diff validation", command: "git diff --check" },
          { id: "status", label: "Git status", command: "git status --short" },
        ]),
        validateParameters: requireNoParameters,
      },
    },
  },
  project_verify: {
    description: "Detect a built-in project profile and run its standard verification sequence.",
    defaultPreset: "standard",
    policy: ["workspace_modify", "long_running"],
    presets: {
      quick: {
        description: "Run the quick verification sequence selected by the matched project profile.",
        validateParameters: validateProjectVerifyParameters,
      },
      standard: {
        description: "Run the standard verification sequence selected by the matched project profile.",
        validateParameters: validateProjectVerifyParameters,
      },
    },
  },
};

export function isWorkspaceActionName(action: string): action is WorkspaceActionName {
  return (WORKSPACE_ACTION_NAMES as readonly string[]).includes(action);
}

export function workspaceActionCatalog(): Array<{
  action: WorkspaceActionName;
  description: string;
  defaultPreset: string;
  presets: Array<{ name: string; description: string }>;
  policy: WorkspaceActionPolicy[];
}> {
  return WORKSPACE_ACTION_NAMES.map((action) => {
    const definition = WORKSPACE_ACTIONS[action];
    return {
      action,
      description: definition.description,
      defaultPreset: definition.defaultPreset,
      presets: Object.entries(definition.presets).map(([name, preset]) => ({
        name,
        description: preset.description,
      })),
      policy: [...definition.policy],
    };
  });
}

export async function resolveWorkspaceAction(
  input: ResolveWorkspaceActionInput,
): Promise<ResolvedWorkspaceAction> {
  if (!isWorkspaceActionName(input.action)) {
    throw new WorkspaceActionResolutionError({
      kind: "unsupported_action",
      message: `Unsupported workspace action: ${input.action}.`,
      requestedAction: input.action,
      requestedPreset: input.preset,
    });
  }

  const definition = WORKSPACE_ACTIONS[input.action];
  const presetName = input.preset?.trim() || definition.defaultPreset;
  const preset = definition.presets[presetName];
  if (!preset) {
    throw new WorkspaceActionResolutionError({
      kind: "unsupported_preset",
      message: `Unsupported preset for ${input.action}: ${presetName}.`,
      requestedAction: input.action,
      requestedPreset: presetName,
    });
  }

  const parameters = input.parameters ?? EMPTY_PARAMETERS;
  try {
    preset.validateParameters(parameters);
  } catch (error) {
    throw new WorkspaceActionResolutionError({
      kind: "invalid_parameters",
      message: error instanceof Error ? error.message : String(error),
      requestedAction: input.action,
      requestedPreset: presetName,
    });
  }

  if (input.action === "project_verify") {
    try {
      const profileResolution = await resolveProjectVerifyProfile({
        workspaceRoot: input.workspaceRoot,
        requestedProfile: projectVerifyProfileParameter(parameters),
        preset: presetName as "quick" | "standard",
      });
      const command = compileWorkspaceActionPlan(profileResolution.plan);
      return {
        action: input.action,
        preset: presetName,
        parameters: { ...parameters },
        executable: "shell",
        args: [],
        command,
        displayCommand: command,
        description: profileResolution.description,
        policy: [...profileResolution.policy],
        profile: profileResolution.profile,
        plan: profileResolution.plan,
      };
    } catch (error) {
      if (!(error instanceof ProjectProfileResolutionError)) throw error;
      throw new WorkspaceActionResolutionError({
        kind: error.kind,
        message: error.message,
        requestedAction: input.action,
        requestedPreset: presetName,
      });
    }
  }

  if (!preset.plan) {
    throw new Error(`Workspace action preset has no execution plan: ${input.action}/${presetName}`);
  }
  const command = compileWorkspaceActionPlan(preset.plan);
  return {
    action: input.action,
    preset: presetName,
    parameters: { ...parameters },
    executable: "shell",
    args: [],
    command,
    displayCommand: command,
    description: preset.description,
    policy: [...definition.policy],
    plan: preset.plan,
  };
}

function requireNoParameters(parameters: Record<string, unknown>): void {
  const names = Object.keys(parameters);
  if (names.length > 0) {
    throw new Error(`This action preset does not accept parameters: ${names.join(", ")}`);
  }
}

function validateProjectVerifyParameters(parameters: Record<string, unknown>): void {
  const unknown = Object.keys(parameters).filter((name) => name !== "profile");
  if (unknown.length > 0) {
    throw new Error(`This action preset accepts only the profile parameter: ${unknown.join(", ")}`);
  }
  const profile = parameters.profile;
  if (profile !== undefined && (typeof profile !== "string" || profile.trim() === "")) {
    throw new Error("The project_verify profile parameter must be a non-empty string.");
  }
}

function projectVerifyProfileParameter(parameters: Record<string, unknown>): string | undefined {
  const profile = parameters.profile;
  return typeof profile === "string" ? profile : undefined;
}
