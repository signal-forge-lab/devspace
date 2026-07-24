import {
  assertWorkspaceActionExecutablesAvailable,
  RequiredExecutableMissingError,
} from "./executable-resolution.js";
import {
  ProjectProfileResolutionError,
  resolveChangedTestsProfile,
  resolveProjectReportProfile,
  resolveProjectVerifyProfile,
  type ProjectProfileName,
} from "./project-profiles.js";
import {
  compileWorkspaceActionPlan,
  processStep,
  workspaceActionSteps,
  WorkspaceActionPlanResolutionError,
  type WorkspaceActionArtifact,
  type WorkspaceActionExecutionPlan,
} from "./workspace-action-plans.js";

export const WORKSPACE_ACTION_NAMES = [
  "workspace_verify",
  "workspace_review",
  "project_verify",
  "test_changed",
  "project_report",
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
  executableEnvironment?: NodeJS.ProcessEnv;
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
  | "not_git_workspace"
  | "no_changed_files"
  | "no_exact_test_mapping"
  | "action_plan_too_large"
  | "ambiguous_test_runner"
  | "required_executable_missing"
  | "unsafe_changed_path"
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
  command: string;
  displayCommand: string;
  description: string;
  policy: WorkspaceActionPolicy[];
  profile?: ProjectProfileName;
  profileEvidence: string[];
  warnings: string[];
  artifacts: WorkspaceActionArtifact[];
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
const MAX_PROFILE_EVIDENCE_ITEMS = 20;
const MAX_PROFILE_EVIDENCE_CHARACTERS = 4_000;

const WORKSPACE_ACTIONS: Record<WorkspaceActionName, WorkspaceActionDefinition> = {
  workspace_verify: {
    description: "Compatibility action for the Workbridge standard project verification sequence.",
    defaultPreset: "standard",
    policy: ["workspace_modify", "long_running"],
    presets: {
      standard: {
        description: "Run project_verify/standard with the built-in workbridge profile.",
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
        plan: workspaceActionSteps([
          processStep("status", "Git status", "git", ["status", "--short"]),
          processStep("unstaged-stat", "Unstaged diff statistics", "git", ["diff", "--stat"]),
          processStep("staged-stat", "Staged diff statistics", "git", ["diff", "--cached", "--stat"]),
        ]),
        validateParameters: requireNoParameters,
      },
      integrity: {
        description: "Validate diff whitespace and show concise working-tree status.",
        plan: workspaceActionSteps([
          processStep("diff-check", "Git diff validation", "git", ["diff", "--check"]),
          processStep("status", "Git status", "git", ["status", "--short"]),
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
  test_changed: {
    description: "Run only tests with exact mappings from the current Git changes.",
    defaultPreset: "exact",
    policy: ["workspace_modify", "long_running"],
    presets: {
      exact: {
        description: "Run exact changed-file test mappings without heuristic runner selection.",
        validateParameters: validateProjectVerifyParameters,
      },
    },
  },
  project_report: {
    description: "Write a JSON report describing the detected project profile and standard verification plan.",
    defaultPreset: "profile",
    policy: ["workspace_modify"],
    presets: {
      profile: {
        description: "Generate a project profile report under .workbridge/reports.",
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
      return await finalizeResolvedAction(input.workspaceRoot, {
        action: input.action,
        preset: presetName,
        parameters: { ...parameters },
        command,
        displayCommand: command,
        description: profileResolution.description,
        policy: [...profileResolution.policy],
        profile: profileResolution.profile,
        profileEvidence: boundedProfileEvidence(profileResolution.evidence),
        warnings: [],
        artifacts: [],
        plan: profileResolution.plan,
      }, input.executableEnvironment);
    } catch (error) {
      if (error instanceof WorkspaceActionResolutionError) throw error;
      if (
        !(error instanceof ProjectProfileResolutionError)
        && !(error instanceof WorkspaceActionPlanResolutionError)
      ) throw error;
      throw new WorkspaceActionResolutionError({
        kind: error.kind,
        message: error.message,
        requestedAction: input.action,
        requestedPreset: presetName,
      });
    }
  }

  if (input.action === "workspace_verify") {
    try {
      const profileResolution = await resolveProjectVerifyProfile({
        workspaceRoot: input.workspaceRoot,
        requestedProfile: "workbridge",
        preset: "standard",
      });
      const command = compileWorkspaceActionPlan(profileResolution.plan);
      return await finalizeResolvedAction(input.workspaceRoot, {
        action: input.action,
        preset: presetName,
        parameters: { ...parameters },
        command,
        displayCommand: command,
        description: "Compatibility alias for project_verify/standard with profile=workbridge.",
        policy: [...profileResolution.policy],
        profile: profileResolution.profile,
        profileEvidence: boundedProfileEvidence(profileResolution.evidence),
        warnings: ["workspace_verify is a compatibility alias; prefer project_verify."],
        artifacts: [],
        plan: profileResolution.plan,
      }, input.executableEnvironment);
    } catch (error) {
      if (error instanceof WorkspaceActionResolutionError) throw error;
      if (
        !(error instanceof ProjectProfileResolutionError)
        && !(error instanceof WorkspaceActionPlanResolutionError)
      ) throw error;
      throw new WorkspaceActionResolutionError({
        kind: error.kind,
        message: error.message,
        requestedAction: input.action,
        requestedPreset: presetName,
      });
    }
  }

  if (input.action === "test_changed") {
    try {
      const profileResolution = await resolveChangedTestsProfile({
        workspaceRoot: input.workspaceRoot,
        requestedProfile: projectVerifyProfileParameter(parameters),
      });
      const command = compileWorkspaceActionPlan(profileResolution.plan);
      return await finalizeResolvedAction(input.workspaceRoot, {
        action: input.action,
        preset: presetName,
        parameters: { ...parameters },
        command,
        displayCommand: command,
        description: profileResolution.description,
        policy: [...profileResolution.policy],
        profile: profileResolution.profile,
        profileEvidence: boundedProfileEvidence(profileResolution.evidence),
        warnings: [],
        artifacts: [],
        plan: profileResolution.plan,
      }, input.executableEnvironment);
    } catch (error) {
      if (error instanceof WorkspaceActionResolutionError) throw error;
      if (
        !(error instanceof ProjectProfileResolutionError)
        && !(error instanceof WorkspaceActionPlanResolutionError)
      ) throw error;
      throw new WorkspaceActionResolutionError({
        kind: error.kind,
        message: error.message,
        requestedAction: input.action,
        requestedPreset: presetName,
      });
    }
  }

  if (input.action === "project_report") {
    try {
      const profileResolution = await resolveProjectReportProfile({
        workspaceRoot: input.workspaceRoot,
        requestedProfile: projectVerifyProfileParameter(parameters),
      });
      const command = compileWorkspaceActionPlan(profileResolution.plan);
      return await finalizeResolvedAction(input.workspaceRoot, {
        action: input.action,
        preset: presetName,
        parameters: { ...parameters },
        command,
        displayCommand: command,
        description: profileResolution.description,
        policy: ["workspace_modify"],
        profile: profileResolution.profile,
        profileEvidence: boundedProfileEvidence(profileResolution.evidence),
        warnings: [],
        artifacts: [{
          path: profileResolution.artifactPath,
          kind: "report",
          description: "Detected project profile and standard verification plan.",
        }],
        plan: profileResolution.plan,
      }, input.executableEnvironment);
    } catch (error) {
      if (error instanceof WorkspaceActionResolutionError) throw error;
      if (
        !(error instanceof ProjectProfileResolutionError)
        && !(error instanceof WorkspaceActionPlanResolutionError)
      ) throw error;
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
  return await finalizeResolvedAction(input.workspaceRoot, {
    action: input.action,
    preset: presetName,
    parameters: { ...parameters },
    command,
    displayCommand: command,
    description: preset.description,
    policy: [...definition.policy],
    profileEvidence: [],
    warnings: [],
    artifacts: [],
    plan: preset.plan,
  }, input.executableEnvironment);
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

function boundedProfileEvidence(evidence: readonly string[]): string[] {
  const totalCharacters = evidence.reduce((total, entry) => total + entry.length, 0);
  if (
    evidence.length > MAX_PROFILE_EVIDENCE_ITEMS
    || totalCharacters > MAX_PROFILE_EVIDENCE_CHARACTERS
  ) {
    throw new WorkspaceActionPlanResolutionError(
      `Workspace action profile evidence exceeds the supported limit (${evidence.length} items, ${totalCharacters} characters).`,
    );
  }
  return [...evidence];
}

async function finalizeResolvedAction(
  workspaceRoot: string,
  resolved: ResolvedWorkspaceAction,
  executableEnvironment: NodeJS.ProcessEnv | undefined,
): Promise<ResolvedWorkspaceAction> {
  try {
    await assertWorkspaceActionExecutablesAvailable(resolved.plan, {
      cwd: workspaceRoot,
      env: executableEnvironment,
    });
    return resolved;
  } catch (error) {
    if (!(error instanceof RequiredExecutableMissingError)) throw error;
    throw new WorkspaceActionResolutionError({
      kind: error.kind,
      message: error.message,
      requestedAction: resolved.action,
      requestedPreset: resolved.preset,
    });
  }
}
