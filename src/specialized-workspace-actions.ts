import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import { isPathInsideRoot, resolveAllowedRealPath } from "./roots.js";
import {
  compileWorkspaceActionPlan,
  processStep,
  workspaceActionSteps,
  type WorkspaceActionExecutionPlan,
} from "./workspace-action-plans.js";
import type {
  ResolvedWorkspaceAction,
  WorkspaceActionResolutionErrorKind,
} from "./workspace-actions.js";

const AO_REGISTERED_MODULE = "tradingagents.ao_d60_registered_run";
const AO_REGISTERED_MODULE_PATH = "tradingagents/ao_d60_registered_run.py";
const AO_DRY_RUN_MODULE_PATH = "tradingagents/ao_dry_run.py";
const AO_REGISTERED_MARKET_FREEZE_MODULE = "tradingagents.ao_registered_market_freeze";
const AO_REGISTERED_MARKET_FREEZE_MODULE_PATH = "tradingagents/ao_registered_market_freeze.py";
const AO_FREEZE_FIRST_RUN_MODULE = "tradingagents.ao_freeze_first_run";
const AO_FREEZE_FIRST_RUN_MODULE_PATH = "tradingagents/ao_freeze_first_run.py";
const AO_REGISTERED_EXECUTE_PARAMETER_NAMES = [
  "windowOpenUtc",
  "windowCloseUtc",
  "bindingPath",
  "registrationPath",
  "d60TaskPath",
  "d61TaskPath",
  "d62TaskPath",
  "d63TaskPath",
  "pricingSnapshotPath",
  "outputPath",
] as const;
type AoRegisteredExecuteParameterName =
  (typeof AO_REGISTERED_EXECUTE_PARAMETER_NAMES)[number];
type AoRegisteredPathParameterName = Exclude<
  AoRegisteredExecuteParameterName,
  "windowOpenUtc" | "windowCloseUtc"
>;
const AO_FREEZE_FIRST_EXECUTE_PARAMETER_NAMES = [
  "bindingPath",
  "bindingSha256",
  "freezeOutputPath",
  "decisionOutputPath",
  "cryptoRootPath",
] as const;
type AoFreezeFirstExecuteParameterName =
  (typeof AO_FREEZE_FIRST_EXECUTE_PARAMETER_NAMES)[number];

type SpecializedResolvedWorkspaceAction = ResolvedWorkspaceAction & {
  plan: WorkspaceActionExecutionPlan;
};

export class SpecializedWorkspaceActionResolutionError extends Error {
  readonly kind: WorkspaceActionResolutionErrorKind;
  readonly requestedAction: "ao_registered_python" | "aegis_runner";
  readonly requestedPreset: string;

  constructor(input: {
    kind: WorkspaceActionResolutionErrorKind;
    message: string;
    requestedAction: "ao_registered_python" | "aegis_runner";
    requestedPreset: string;
  }) {
    super(input.message);
    this.name = "SpecializedWorkspaceActionResolutionError";
    this.kind = input.kind;
    this.requestedAction = input.requestedAction;
    this.requestedPreset = input.requestedPreset;
  }
}

export function validateAoRegisteredExecuteParameters(parameters: Record<string, unknown>): void {
  const allowed = new Set<string>(AO_REGISTERED_EXECUTE_PARAMETER_NAMES);
  const unknown = Object.keys(parameters).filter((name) => !allowed.has(name));
  if (unknown.length > 0) {
    throw new Error(`ao_registered_python/execute received unsupported parameters: ${unknown.join(", ")}`);
  }
  const missing = AO_REGISTERED_EXECUTE_PARAMETER_NAMES.filter((name) => !(name in parameters));
  if (missing.length > 0) {
    throw new Error(`ao_registered_python/execute requires parameters: ${missing.join(", ")}`);
  }

  const open = strictUtcTimestampParameter(parameters, "windowOpenUtc");
  const close = strictUtcTimestampParameter(parameters, "windowCloseUtc");
  if (Date.parse(open) >= Date.parse(close)) {
    throw new Error("windowOpenUtc must be earlier than windowCloseUtc.");
  }

  for (const name of AO_REGISTERED_EXECUTE_PARAMETER_NAMES) {
    if (name === "windowOpenUtc" || name === "windowCloseUtc") continue;
    absolutePathParameter(parameters, name);
  }
}

export function validateAoFreezeFirstExecuteParameters(parameters: Record<string, unknown>): void {
  const allowed = new Set<string>(AO_FREEZE_FIRST_EXECUTE_PARAMETER_NAMES);
  const unknown = Object.keys(parameters).filter((name) => !allowed.has(name));
  if (unknown.length > 0) {
    throw new Error(`ao_registered_python/freeze_first_execute received unsupported parameters: ${unknown.join(", ")}`);
  }
  const missing = AO_FREEZE_FIRST_EXECUTE_PARAMETER_NAMES.filter((name) => !(name in parameters));
  if (missing.length > 0) {
    throw new Error(`ao_registered_python/freeze_first_execute requires parameters: ${missing.join(", ")}`);
  }
  for (const name of ["bindingPath", "freezeOutputPath", "decisionOutputPath", "cryptoRootPath"] as const) {
    absolutePathParameter(parameters, name);
  }
  const bindingSha256 = parameters.bindingSha256;
  if (typeof bindingSha256 !== "string" || !/^[0-9a-f]{64}$/.test(bindingSha256)) {
    throw new Error("bindingSha256 must be a lowercase SHA-256.");
  }
}

export async function resolveAegisRunnerAction(
  workspaceRoot: string,
  preset: string,
): Promise<SpecializedResolvedWorkspaceAction> {
  try {
    const details = await stat(join(workspaceRoot, "aegis_runner.py"));
    if (!details.isFile()) throw new Error("not a regular file");
  } catch {
    throw new SpecializedWorkspaceActionResolutionError({
      kind: "unsupported_action_for_profile",
      message: "aegis_runner requires aegis_runner.py in the selected workspace root.",
      requestedAction: "aegis_runner",
      requestedPreset: preset,
    });
  }

  const python = process.platform === "win32" ? "python" : "python3";
  const plan = workspaceActionSteps([
    processStep(
      "launch",
      "Launch autonomous Aegis Runner",
      python,
      ["-X", "utf8", "aegis_runner.py", "run", "--confirm-post"],
    ),
  ]);
  const command = compileWorkspaceActionPlan(plan);
  return {
    action: "aegis_runner",
    preset,
    parameters: {},
    command,
    displayCommand: command,
    description: "Launch the canonical Aegis Runner autonomous flow independently of MCP process-session lifetime.",
    policy: ["workspace_modify", "external_effect", "long_running"],
    profileEvidence: ["fixed entrypoint: aegis_runner.py", "runtime authority: Aegis heartbeat and canonical Goal state"],
    warnings: ["Detached Aegis execution has no write_stdin session; observe its heartbeat and canonical state instead."],
    artifacts: [],
    plan,
  };
}

export async function resolveAoRegisteredPythonAction(input: {
  workspaceRoot: string;
  preset: "help" | "credential_presence" | "execute" | "freeze_first_execute";
  parameters: Record<string, unknown>;
  allowedRoots?: string[];
}): Promise<SpecializedResolvedWorkspaceAction> {
  if (!input.allowedRoots || input.allowedRoots.length === 0) {
    throw new SpecializedWorkspaceActionResolutionError({
      kind: "invalid_parameters",
      message: "ao_registered_python requires the server allowed-root set for project and path validation.",
      requestedAction: "ao_registered_python",
      requestedPreset: input.preset,
    });
  }

  const requiredModulePaths = input.preset === "freeze_first_execute"
    ? [AO_REGISTERED_MARKET_FREEZE_MODULE_PATH, AO_FREEZE_FIRST_RUN_MODULE_PATH]
    : input.preset === "credential_presence"
      ? [AO_DRY_RUN_MODULE_PATH]
      : [AO_REGISTERED_MODULE_PATH];
  try {
    for (const modulePath of requiredModulePaths) {
      const resolvedModulePath = await resolveAllowedRealPath(
        join(input.workspaceRoot, ...modulePath.split("/")),
        input.workspaceRoot,
        input.allowedRoots,
      );
      const details = await stat(resolvedModulePath);
      if (!details.isFile()) throw new Error("module path is not a regular file");
    }
  } catch {
    throw new SpecializedWorkspaceActionResolutionError({
      kind: "unsupported_action_for_profile",
      message: `ao_registered_python requires ${requiredModulePaths.join(" and ")} in the selected project root.`,
      requestedAction: "ao_registered_python",
      requestedPreset: input.preset,
    });
  }

  const python = process.platform === "win32" ? "py" : "python3";
  if (input.preset === "credential_presence") {
    const code = [
      "from tradingagents.ao_dry_run import _credential_source",
      "s=_credential_source('IW_AO_OPENAI_API_KEY')",
      "print('credential_present=' + str(s is not None).lower())",
      "print('credential_source=' + (s or 'none'))",
      "print('secret_value_observed=false')",
    ].join("; ");
    const plan = workspaceActionSteps([
      processStep(
        "credential-presence",
        "AO designated credential presence",
        python,
        ["-c", code],
      ),
    ]);
    const command = compileWorkspaceActionPlan(plan);
    return {
      action: "ao_registered_python",
      preset: "credential_presence",
      parameters: {},
      command,
      displayCommand: `${python} -c <fixed AO credential-presence check>`,
      description: "Check only whether IW_AO_OPENAI_API_KEY is available to the registered AO producer path.",
      policy: ["read_only"],
      profile: "python",
      profileEvidence: [
        `fixed module path: ${AO_DRY_RUN_MODULE_PATH}`,
        "credential name: IW_AO_OPENAI_API_KEY",
        "secret value: never returned, printed, hashed, or persisted",
      ],
      warnings: [],
      artifacts: [],
      plan,
    };
  }

  if (input.preset === "help") {
    const plan = workspaceActionSteps([
      processStep(
        "module-help",
        "AO registered producer module help",
        python,
        ["-m", AO_REGISTERED_MODULE, "--help"],
      ),
    ]);
    const command = compileWorkspaceActionPlan(plan);
    return {
      action: "ao_registered_python",
      preset: "help",
      parameters: {},
      command,
      displayCommand: command,
      description: "Start only the fixed AO registered producer module help entrypoint.",
      policy: ["read_only"],
      profile: "python",
      profileEvidence: [
        `fixed module: ${AO_REGISTERED_MODULE}`,
        `module path: ${AO_REGISTERED_MODULE_PATH}`,
        "scientific input parameters: none",
      ],
      warnings: [],
      artifacts: [],
      plan,
    };
  }

  if (input.preset === "freeze_first_execute") {
    const normalized = await normalizeAoFreezeFirstExecuteParameters(
      input.workspaceRoot,
      input.parameters,
      input.allowedRoots,
    );
    const plan = workspaceActionSteps([
      processStep(
        "registered-market-freeze",
        "AO registered market freeze",
        python,
        [
          "-m", AO_REGISTERED_MARKET_FREEZE_MODULE,
          "--binding", normalized.bindingPath,
          "--output", normalized.freezeOutputPath,
        ],
      ),
      processStep(
        "frozen-provider-decision",
        "AO frozen provider decision",
        python,
        [
          "-m", AO_FREEZE_FIRST_RUN_MODULE,
          "--binding", normalized.bindingPath,
          "--freeze-root", normalized.freezeOutputPath,
          "--output", normalized.decisionOutputPath,
          "--crypto-root", normalized.cryptoRootPath,
        ],
      ),
    ]);
    const command = compileWorkspaceActionPlan(plan);
    return {
      action: "ao_registered_python",
      preset: "freeze_first_execute",
      parameters: normalized,
      command,
      displayCommand: command,
      description: "Freeze one registered AO market input, then execute the provider only from the validated frozen bundle.",
      policy: ["workspace_modify", "external_effect", "long_running"],
      profile: "python",
      profileEvidence: [
        `fixed modules: ${AO_REGISTERED_MARKET_FREEZE_MODULE}, ${AO_FREEZE_FIRST_RUN_MODULE}`,
        "binding content: exact SHA-256 checked during every action resolution",
        "execution order: market freeze must succeed before provider decision starts",
        "output roots: absent descendants of the selected producer workspace",
        "argument transport: executable plus argv; no shell fragment parameter",
      ],
      warnings: [],
      artifacts: [
        {
          path: relative(input.workspaceRoot, normalized.freezeOutputPath).replaceAll("\\", "/"),
          kind: "directory",
          description: "Create-new-only registered market freeze root.",
        },
        {
          path: relative(input.workspaceRoot, normalized.decisionOutputPath).replaceAll("\\", "/"),
          kind: "directory",
          description: "Create-new-only frozen provider decision root.",
        },
      ],
      plan,
    };
  }

  const normalized = await normalizeAoRegisteredExecuteParameters(
    input.workspaceRoot,
    input.parameters,
    input.allowedRoots,
  );
  const plan = workspaceActionSteps([
    processStep(
      "registered-run",
      "AO registered producer execution",
      python,
      [
        "-m", AO_REGISTERED_MODULE,
        "--window-open-utc", normalized.windowOpenUtc,
        "--window-close-utc", normalized.windowCloseUtc,
        "--binding", normalized.bindingPath,
        "--registration", normalized.registrationPath,
        "--d60-task", normalized.d60TaskPath,
        "--d61-task", normalized.d61TaskPath,
        "--d62-task", normalized.d62TaskPath,
        "--d63-task", normalized.d63TaskPath,
        "--pricing-snapshot", normalized.pricingSnapshotPath,
        "--output", normalized.outputPath,
        "--execute-registered",
      ],
    ),
  ]);
  const command = compileWorkspaceActionPlan(plan);
  return {
    action: "ao_registered_python",
    preset: "execute",
    parameters: normalized,
    command,
    displayCommand: command,
    description: "Run one future AO registration through the fixed producer module and allowlisted arguments.",
    policy: ["workspace_modify", "external_effect", "long_running"],
    profile: "python",
    profileEvidence: [
      `fixed module: ${AO_REGISTERED_MODULE}`,
      `module path: ${AO_REGISTERED_MODULE_PATH}`,
      "all input paths: existing files beneath server allowed roots",
      "output path: absent and beneath the selected producer workspace",
      "argument transport: executable plus argv; no shell fragment parameter",
    ],
    warnings: [],
    artifacts: [{
      path: relative(input.workspaceRoot, normalized.outputPath).replaceAll("\\", "/"),
      kind: "directory",
      description: "Create-new-only output root for the future registered run.",
    }],
    plan,
  };
}

async function normalizeAoFreezeFirstExecuteParameters(
  workspaceRoot: string,
  parameters: Record<string, unknown>,
  allowedRoots: string[],
): Promise<Record<AoFreezeFirstExecuteParameterName, string>> {
  const bindingPath = await allowedAoPath(
    absolutePathParameter(parameters, "bindingPath"),
    workspaceRoot,
    allowedRoots,
    "bindingPath",
  );
  const bindingDetails = await stat(bindingPath);
  if (!bindingDetails.isFile()) {
    throw new SpecializedWorkspaceActionResolutionError({
      kind: "invalid_parameters",
      message: "bindingPath must identify a file.",
      requestedAction: "ao_registered_python",
      requestedPreset: "freeze_first_execute",
    });
  }
  const bindingSha256 = String(parameters.bindingSha256);
  const actualBindingSha256 = createHash("sha256").update(await readFile(bindingPath)).digest("hex");
  if (actualBindingSha256 !== bindingSha256) {
    throw new SpecializedWorkspaceActionResolutionError({
      kind: "invalid_parameters",
      message: "bindingPath content does not match bindingSha256.",
      requestedAction: "ao_registered_python",
      requestedPreset: "freeze_first_execute",
    });
  }

  const cryptoRootPath = await allowedAoPath(
    absolutePathParameter(parameters, "cryptoRootPath"),
    workspaceRoot,
    allowedRoots,
    "cryptoRootPath",
  );
  const cryptoRootDetails = await stat(cryptoRootPath);
  if (!cryptoRootDetails.isDirectory()) {
    throw new SpecializedWorkspaceActionResolutionError({
      kind: "invalid_parameters",
      message: "cryptoRootPath must identify a directory.",
      requestedAction: "ao_registered_python",
      requestedPreset: "freeze_first_execute",
    });
  }

  const freezeOutputPath = await newAoOutputPath(
    workspaceRoot,
    parameters,
    allowedRoots,
    "freezeOutputPath",
    "freeze_first_execute",
  );
  const decisionOutputPath = await newAoOutputPath(
    workspaceRoot,
    parameters,
    allowedRoots,
    "decisionOutputPath",
    "freeze_first_execute",
  );
  if (freezeOutputPath === decisionOutputPath) {
    throw new SpecializedWorkspaceActionResolutionError({
      kind: "invalid_parameters",
      message: "freezeOutputPath and decisionOutputPath must be different paths.",
      requestedAction: "ao_registered_python",
      requestedPreset: "freeze_first_execute",
    });
  }

  return {
    bindingPath,
    bindingSha256,
    freezeOutputPath,
    decisionOutputPath,
    cryptoRootPath,
  };
}

async function normalizeAoRegisteredExecuteParameters(
  workspaceRoot: string,
  parameters: Record<string, unknown>,
  allowedRoots: string[],
): Promise<Record<AoRegisteredExecuteParameterName, string>> {
  const normalized = {} as Record<AoRegisteredExecuteParameterName, string>;
  normalized.windowOpenUtc = strictUtcTimestampParameter(parameters, "windowOpenUtc");
  normalized.windowCloseUtc = strictUtcTimestampParameter(parameters, "windowCloseUtc");

  const fileNames: AoRegisteredPathParameterName[] = [
    "bindingPath",
    "registrationPath",
    "d60TaskPath",
    "d61TaskPath",
    "d62TaskPath",
    "d63TaskPath",
    "pricingSnapshotPath",
  ];
  for (const name of fileNames) {
    const requested = absolutePathParameter(parameters, name);
    const resolved = await allowedAoPath(requested, workspaceRoot, allowedRoots, name);
    let details;
    try {
      details = await stat(resolved);
    } catch {
      throw new SpecializedWorkspaceActionResolutionError({
        kind: "invalid_parameters",
        message: `${name} must identify an existing file beneath a server allowed root.`,
        requestedAction: "ao_registered_python",
        requestedPreset: "execute",
      });
    }
    if (!details.isFile()) {
      throw new SpecializedWorkspaceActionResolutionError({
        kind: "invalid_parameters",
        message: `${name} must identify a file.`,
        requestedAction: "ao_registered_python",
        requestedPreset: "execute",
      });
    }
    normalized[name] = resolved;
  }

  normalized.outputPath = await newAoOutputPath(
    workspaceRoot,
    parameters,
    allowedRoots,
    "outputPath",
    "execute",
  );
  return normalized;
}

async function newAoOutputPath(
  workspaceRoot: string,
  parameters: Record<string, unknown>,
  allowedRoots: string[],
  name: "outputPath" | "freezeOutputPath" | "decisionOutputPath",
  preset: "execute" | "freeze_first_execute",
): Promise<string> {
  const outputRequested = absolutePathParameter(parameters, name);
  const outputPath = await allowedAoPath(outputRequested, workspaceRoot, allowedRoots, name);
  if (!isPathInsideRoot(outputPath, workspaceRoot) || outputPath === workspaceRoot) {
    throw new SpecializedWorkspaceActionResolutionError({
      kind: "invalid_parameters",
      message: `${name} must be a new descendant of the selected producer workspace.`,
      requestedAction: "ao_registered_python",
      requestedPreset: preset,
    });
  }
  try {
    await stat(outputPath);
    throw new SpecializedWorkspaceActionResolutionError({
      kind: "invalid_parameters",
      message: `${name} already exists; registered runs require create-new-only output roots.`,
      requestedAction: "ao_registered_python",
      requestedPreset: preset,
    });
  } catch (error) {
    if (error instanceof SpecializedWorkspaceActionResolutionError) throw error;
    if (!isMissingPathError(error)) throw error;
  }
  return outputPath;
}

function strictUtcTimestampParameter(
  parameters: Record<string, unknown>,
  name: "windowOpenUtc" | "windowCloseUtc",
): string {
  const value = parameters[name];
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(value)) {
    throw new Error(`${name} must use canonical UTC format YYYY-MM-DDTHH:mm:ssZ.`);
  }
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString().replace(".000Z", "Z") !== value) {
    throw new Error(`${name} is not a valid canonical UTC timestamp.`);
  }
  return value;
}

function absolutePathParameter(
  parameters: Record<string, unknown>,
  name: AoRegisteredPathParameterName | "freezeOutputPath" | "decisionOutputPath" | "cryptoRootPath",
): string {
  const value = parameters[name];
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${name} must be a non-empty absolute path.`);
  }
  if (/[\u0000\r\n]/.test(value)) {
    throw new Error(`${name} must not contain control characters.`);
  }
  const trimmed = value.trim();
  if (!isAbsolute(trimmed)) {
    throw new Error(`${name} must be an absolute path.`);
  }
  return trimmed;
}

async function allowedAoPath(
  requested: string,
  workspaceRoot: string,
  allowedRoots: string[],
  name: AoRegisteredPathParameterName | "freezeOutputPath" | "decisionOutputPath" | "cryptoRootPath",
): Promise<string> {
  try {
    return await resolveAllowedRealPath(requested, workspaceRoot, allowedRoots);
  } catch (error) {
    throw new SpecializedWorkspaceActionResolutionError({
      kind: "invalid_parameters",
      message: `${name} was rejected by server allowed-root validation: ${error instanceof Error ? error.message : String(error)}`,
      requestedAction: "ao_registered_python",
      requestedPreset: "execute",
    });
  }
}

function isMissingPathError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error
    && ((error as NodeJS.ErrnoException).code === "ENOENT"
      || (error as NodeJS.ErrnoException).code === "ENOTDIR");
}
