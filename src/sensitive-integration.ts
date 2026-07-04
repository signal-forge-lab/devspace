export type SecretValueHandling = "never_read_or_write" | "mock_only";
export type SensitiveIntegrationMode = "config_only" | "mock_first" | "config_and_mock_only";

export interface EnvVarReference {
  kind: "env_var";
  name: string;
  required?: boolean;
  configKey?: string;
}

export interface SensitiveIntegrationWorkflowInput extends Record<string, unknown> {
  provider?: string;
  envVar?: EnvVarReference;
  envVarName?: string;
  configKey?: string;
  secretValueHandling: SecretValueHandling;
  mode?: SensitiveIntegrationMode;
  allowLiveSmoke?: boolean;
  mockValueLabel?: string;
}

export interface SensitiveIntegrationWorkflowPlan extends Record<string, unknown> {
  envVar: EnvVarReference;
  secretValueHandling: SecretValueHandling;
  mode: SensitiveIntegrationMode;
  liveSmokeAllowed: boolean;
  recommendedSequence: string[];
  requiredChecks: string[];
  result: string;
}

const ENV_VAR_NAME_PATTERN = /^[A-Z_][A-Z0-9_]{0,127}$/;
const FORBIDDEN_SECRET_VALUE_KEYS = ["secretValue", "apiKey", "token", "authorization", "authorizationHeader", "cookie", "session"];
const SECRET_VALUE_KEY_PATTERN = /(secret|api[_-]?key|token|authorization|cookie|session|credential|password)/i;
const ALLOWED_REFERENCE_KEYS = new Set(["kind", "name", "required", "configKey", "provider", "envVar", "envVarName", "secretValueHandling", "mode", "allowLiveSmoke", "mockValueLabel"]);

export function validateEnvVarName(name: string): string {
  if (!ENV_VAR_NAME_PATTERN.test(name)) {
    throw new Error("env var name must match /^[A-Z_][A-Z0-9_]{0,127}$/.");
  }
  return name;
}

export function createEnvVarReference(input: string | EnvVarReference, configKey?: string): EnvVarReference {
  if (typeof input === "string") return { kind: "env_var", name: validateEnvVarName(input), configKey };
  rejectSecretValueFields(input as unknown as Record<string, unknown>);
  if (input.kind !== "env_var") throw new Error("env var reference kind must be env_var.");
  return { kind: "env_var", name: validateEnvVarName(input.name), required: input.required, configKey: input.configKey ?? configKey };
}

export function prepareSensitiveIntegrationWorkflow(input: SensitiveIntegrationWorkflowInput): SensitiveIntegrationWorkflowPlan {
  rejectSecretValueFields(input);
  validateSecretValueHandling(input.secretValueHandling);
  const mode = validateSensitiveIntegrationMode(input.mode ?? "config_and_mock_only");
  const envVar = createEnvVarReference(input.envVar ?? requiredString(input.envVarName, "envVarName"), input.configKey);
  const liveSmokeAllowed = input.allowLiveSmoke === true;
  if (liveSmokeAllowed && input.secretValueHandling !== "mock_only") {
    throw new Error("live smoke can only be planned with mock_only handling in DevSpace; real secret values must stay outside the workflow.");
  }
  const recommendedSequence = mode === "config_only"
    ? ["validate_env_var_reference", "write_config_schema_reference", "workbridge_verify:typecheck_only", "workbridge_verify:git_diff_check"]
    : ["validate_env_var_reference", "write_config_schema_reference", "write_mock_first_test", "workbridge_verify:typecheck_only", "workbridge_verify:workflow_tools_test", "workbridge_verify:git_diff_check"];
  const requiredChecks = ["env_var_name_validation", "secret_value_fields_absent", "no_secret_value_logging", liveSmokeAllowed ? "explicit_live_smoke_flag" : "live_smoke_not_executed"];
  return {
    envVar,
    secretValueHandling: input.secretValueHandling,
    mode,
    liveSmokeAllowed,
    recommendedSequence,
    requiredChecks,
    result: `planned sensitive integration for ${envVar.name}: ${mode}, ${input.secretValueHandling}`,
  };
}

function rejectSecretValueFields(input: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(input)) {
    if (ALLOWED_REFERENCE_KEYS.has(key)) continue;
    if (FORBIDDEN_SECRET_VALUE_KEYS.includes(key) || SECRET_VALUE_KEY_PATTERN.test(key)) {
      if (value !== undefined) throw new Error(`real secret value field is not accepted: ${key}. Use an env var reference or mock label instead.`);
    }
  }
}

function validateSecretValueHandling(value: unknown): SecretValueHandling {
  if (value === "never_read_or_write" || value === "mock_only") return value;
  throw new Error("secretValueHandling must be never_read_or_write or mock_only.");
}

function validateSensitiveIntegrationMode(value: unknown): SensitiveIntegrationMode {
  if (value === "config_only" || value === "mock_first" || value === "config_and_mock_only") return value;
  throw new Error("mode must be config_only, mock_first, or config_and_mock_only.");
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${name} is required.`);
  return value;
}
