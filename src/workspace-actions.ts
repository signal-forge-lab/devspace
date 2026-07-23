export const WORKSPACE_ACTION_NAMES = ["workspace_verify"] as const;
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
  | "invalid_parameters";

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
}

interface WorkspaceActionPresetDefinition {
  description: string;
  command: string;
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
        command: [
          "npm run typecheck",
          "npm run baseline:tools:check",
          "npm test",
          "npm run build",
          "git diff --check",
          "git status --short",
        ].join(" && "),
        validateParameters: requireNoParameters,
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

  return {
    action: input.action,
    preset: presetName,
    parameters: { ...parameters },
    executable: "shell",
    args: [],
    command: preset.command,
    displayCommand: preset.command,
    description: preset.description,
    policy: [...definition.policy],
  };
}

function requireNoParameters(parameters: Record<string, unknown>): void {
  const names = Object.keys(parameters);
  if (names.length > 0) {
    throw new Error(`This action preset does not accept parameters: ${names.join(", ")}`);
  }
}
