const DEFAULT_PASSTHROUGH_NAMES = new Set([
  "APPDATA",
  "CI",
  "COMMONPROGRAMFILES",
  "COMMONPROGRAMFILES(X86)",
  "COMPUTERNAME",
  "COMSPEC",
  "GIT_ASKPASS",
  "GIT_CONFIG_GLOBAL",
  "GIT_CONFIG_SYSTEM",
  "GIT_SSH",
  "HOME",
  "HOMEDRIVE",
  "HOMEPATH",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "LOCALAPPDATA",
  "LOGNAME",
  "NUMBER_OF_PROCESSORS",
  "PATH",
  "PATHEXT",
  "PROCESSOR_ARCHITECTURE",
  "PROCESSOR_IDENTIFIER",
  "PROGRAMDATA",
  "PROGRAMFILES",
  "PROGRAMFILES(X86)",
  "PYTHONIOENCODING",
  "PYTHONUTF8",
  "SHELL",
  "SSH_AUTH_SOCK",
  "SYSTEMROOT",
  "TEMP",
  "TMP",
  "TMPDIR",
  "TZ",
  "USER",
  "USERNAME",
  "USERPROFILE",
  "WINDIR",
]);

const ALWAYS_BLOCKED_NAMES = new Set([
  "AUTHORIZATION",
  "DEVSPACE_OAUTH_OWNER_TOKEN",
  "HTTP_AUTHORIZATION",
  "PROXY_AUTHORIZATION",
]);

const ENVIRONMENT_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

export interface ChildProcessEnvironmentInput {
  source?: NodeJS.ProcessEnv;
  workspaceId?: string;
  workspaceRoot?: string;
  allowlist?: Iterable<string>;
}

export function parseChildEnvironmentAllowlist(value: string | undefined): Set<string> {
  if (!value) return new Set();
  return new Set(
    value
      .split(/[\s,;]+/)
      .map((entry) => entry.trim())
      .filter((entry) => ENVIRONMENT_NAME_PATTERN.test(entry))
      .map(normalizeEnvironmentName),
  );
}

export function buildChildProcessEnvironment(
  input: ChildProcessEnvironmentInput = {},
): Record<string, string> {
  const source = input.source ?? process.env;
  const explicitAllowlist = new Set(
    input.allowlist
      ? [...input.allowlist].map(normalizeEnvironmentName)
      : parseChildEnvironmentAllowlist(source.DEVSPACE_CHILD_ENV_ALLOWLIST),
  );
  const environment: Record<string, string> = {};

  for (const [name, value] of Object.entries(source)) {
    if (value === undefined) continue;
    const normalizedName = normalizeEnvironmentName(name);
    if (ALWAYS_BLOCKED_NAMES.has(normalizedName)) continue;
    if (!DEFAULT_PASSTHROUGH_NAMES.has(normalizedName) && !explicitAllowlist.has(normalizedName)) continue;
    environment[name] = value;
  }

  environment.NO_COLOR = "1";
  environment.TERM = "dumb";
  environment.PAGER = "cat";
  environment.GIT_PAGER = "cat";
  environment.GH_PAGER = "cat";
  environment.CODEX_CI = "1";
  environment.LANG = source.LANG ?? "C.UTF-8";
  environment.LC_ALL = source.LC_ALL ?? "C.UTF-8";
  if (input.workspaceId) environment.DEVSPACE_WORKSPACE_ID = input.workspaceId;
  if (input.workspaceRoot) environment.DEVSPACE_WORKSPACE_ROOT = input.workspaceRoot;
  return environment;
}

function normalizeEnvironmentName(name: string): string {
  return name.toUpperCase();
}
