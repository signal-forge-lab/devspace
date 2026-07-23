import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { LEGACY_OAUTH_SCOPE, PRODUCT_DISPLAY_NAME } from "./branding.js";
import { expandHomePath } from "./roots.js";
import type { LoggingConfig, LogFormat, LogLevel } from "./logger.js";
import type { OAuthConfig } from "./oauth-provider.js";
import { devspaceAgentsDir, devspaceSkillsDir, loadDevspaceFiles } from "./user-config.js";

export type ToolMode = "minimal" | "full" | "codex" | "sandbox_bundle";
export type WidgetMode = "off" | "changes" | "full";
export type ExperimentalFeature = "command_metadata" | "shell_command_logging";
const DEFAULT_OAUTH_ACCESS_TOKEN_TTL_SECONDS = 60 * 60;
const DEFAULT_OAUTH_REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;
const DEFAULT_OAUTH_MAX_REGISTERED_CLIENTS = 50;
const DEFAULT_OAUTH_INACTIVE_CLIENT_MAX_AGE_DAYS = 90;
const DEFAULT_OAUTH_AUTH_FAILURE_LIMIT = 5;
const DEFAULT_OAUTH_AUTH_FAILURE_WINDOW_SECONDS = 5 * 60;
const DEFAULT_OAUTH_AUTH_BLOCK_SECONDS = 15 * 60;
const DEFAULT_OAUTH_AUTH_FAILURE_DELAY_MS = 250;
const DEFAULT_ARTIFACT_MAX_FILE_BYTES = 100 * 1024 * 1024;
const DEFAULT_LOG_FILE_MAX_BYTES = 10 * 1024 * 1024;
const DEFAULT_LOG_FILE_MAX_FILES = 5;
const DEFAULT_WORKSPACE_SESSION_MAX_AGE_DAYS = 30;

export interface ServerConfig {
  host: string;
  port: number;
  oauth: OAuthConfig;
  allowedRoots: string[];
  allowedHosts: string[];
  publicBaseUrl: string;
  toolMode: ToolMode;
  experimentalFeatures: ExperimentalFeature[];
  workspaceTasksEnabled: boolean;
  workspaceTaskDynamicArgsEnabled: boolean;
  sandboxBundleEnabled: boolean;
  sandboxBundlePolicyEnabled: boolean;
  widgets: WidgetMode;
  stateDir: string;
  worktreeRoot: string;
  artifactsEnabled: boolean;
  artifactMaxFileBytes: number;
  skillsEnabled: boolean;
  skillPaths: string[];
  devspaceSkillsDir: string;
  devspaceAgentsDir: string;
  subagents: boolean;
  agentDir: string;
  workspaceSessionMaxAgeMs: number;
  logging: LoggingConfig;
}

function parsePort(value: string | number | undefined): number {
  if (value === undefined || value === "") return 7676;

  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid PORT: ${value}`);
  }

  return port;
}

function parseAllowedRoots(value: string | string[] | undefined): string[] {
  if (Array.isArray(value)) {
    const roots = value.map((entry) => entry.trim()).filter(Boolean);
    return (roots.length > 0 ? roots : [process.cwd()]).map((root) => resolve(expandHomePath(root)));
  }

  const rawRoots =
    value
      ?.split(",")
      .map((entry) => entry.trim())
      .filter(Boolean) ?? [];

  const roots = rawRoots.length > 0 ? rawRoots : [process.cwd()];
  return roots.map((root) => resolve(expandHomePath(root)));
}

function parseAllowedHosts(value: string | string[] | undefined, derivedHosts: string[]): string[] {
  if (Array.isArray(value)) {
    return normalizeAllowedHosts(value, derivedHosts);
  }

  const rawHosts =
    value
      ?.split(",")
      .map((entry) => entry.trim())
      .filter(Boolean) ?? [];

  return normalizeAllowedHosts(rawHosts, derivedHosts);
}

function normalizeAllowedHosts(rawHosts: string[], derivedHosts: string[]): string[] {
  const hosts = rawHosts.length > 0 ? rawHosts : derivedHosts;
  if (hosts.includes("*")) return ["*"];
  return Array.from(new Set(hosts.map((host) => host.trim()).filter(Boolean)));
}

function parseBoolean(value: string | undefined): boolean {
  return ["1", "true", "yes", "on"].includes(value?.toLowerCase() ?? "");
}


function parseLogLevel(value: string | undefined): LogLevel {
  if (!value || value === "info") return "info";
  if (["silent", "error", "warn", "debug"].includes(value)) return value as LogLevel;

  throw new Error(`Invalid DEVSPACE_LOG_LEVEL: ${value}`);
}

function parseLogFormat(value: string | undefined): LogFormat {
  if (!value || value === "json") return "json";
  if (value === "pretty") return "pretty";

  throw new Error(`Invalid DEVSPACE_LOG_FORMAT: ${value}`);
}

function parsePathList(value: string | undefined): string[] {
  return (
    value
      ?.split(",")
      .map((entry) => entry.trim())
      .filter(Boolean) ?? []
  );
}

function parseStringList(value: string | undefined, fallback: string[]): string[] {
  const entries = value
    ?.split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);

  return entries && entries.length > 0 ? entries : fallback;
}


function parsePositiveInteger(
  value: string | undefined,
  fallback: number,
  name: string,
  max = Number.MAX_SAFE_INTEGER,
): number {
  if (!value) return fallback;

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > max) {
    throw new Error(`Invalid ${name}: ${value}`);
  }

  return parsed;
}

function parseNonNegativeInteger(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) throw new Error(`Invalid ${name}: ${value}`);
  return parsed;
}

function parseLogFileMaxBytes(value: string | undefined): number | undefined {
  if (value === undefined || value === "") return DEFAULT_LOG_FILE_MAX_BYTES;

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`Invalid DEVSPACE_LOG_FILE_MAX_BYTES: ${value}`);
  }

  return parsed === 0 ? undefined : parsed;
}

function parseLoggingConfig(
  env: NodeJS.ProcessEnv,
  stateDir: string,
): LoggingConfig {
  return {
    level: parseLogLevel(env.DEVSPACE_LOG_LEVEL),
    format: parseLogFormat(env.DEVSPACE_LOG_FORMAT),
    file: env.DEVSPACE_LOG_FILE === undefined ? true : parseBoolean(env.DEVSPACE_LOG_FILE),
    filePath: resolve(expandHomePath(env.DEVSPACE_LOG_FILE_PATH ?? join(stateDir, "logs", "devspace.jsonl"))),
    fileMaxBytes: parseLogFileMaxBytes(env.DEVSPACE_LOG_FILE_MAX_BYTES),
    fileMaxFiles: parsePositiveInteger(
      env.DEVSPACE_LOG_FILE_MAX_FILES,
      DEFAULT_LOG_FILE_MAX_FILES,
      "DEVSPACE_LOG_FILE_MAX_FILES",
    ),
    consoleJson: parseBoolean(env.DEVSPACE_LOG_CONSOLE_JSON),
    requests: env.DEVSPACE_LOG_REQUESTS === undefined ? true : parseBoolean(env.DEVSPACE_LOG_REQUESTS),
    assets: parseBoolean(env.DEVSPACE_LOG_ASSETS),
    toolCalls: env.DEVSPACE_LOG_TOOL_CALLS === undefined ? true : parseBoolean(env.DEVSPACE_LOG_TOOL_CALLS),
    shellCommands: parseBoolean(env.WORKBRIDGE_LOG_SHELL_COMMANDS),
    trustProxy: parseBoolean(env.DEVSPACE_TRUST_PROXY),
  };
}


function parseRequiredSecret(value: string | undefined, name: string): string {
  const secret = value?.trim();
  if (!secret) {
    throw new Error(`${name} is required for ${PRODUCT_DISPLAY_NAME} OAuth. Run: devspace init`);
  }
  if (secret.length < 16) {
    throw new Error(`${name} must be at least 16 characters long.`);
  }
  return secret;
}

function parseOAuthConfig(env: NodeJS.ProcessEnv, ownerToken: string | undefined): OAuthConfig {
  return {
    ownerToken: parseRequiredSecret(env.DEVSPACE_OAUTH_OWNER_TOKEN ?? ownerToken, "DEVSPACE_OAUTH_OWNER_TOKEN"),
    accessTokenTtlSeconds: parsePositiveInteger(
      env.DEVSPACE_OAUTH_ACCESS_TOKEN_TTL_SECONDS,
      DEFAULT_OAUTH_ACCESS_TOKEN_TTL_SECONDS,
      "DEVSPACE_OAUTH_ACCESS_TOKEN_TTL_SECONDS",
    ),
    refreshTokenTtlSeconds: parsePositiveInteger(
      env.DEVSPACE_OAUTH_REFRESH_TOKEN_TTL_SECONDS,
      DEFAULT_OAUTH_REFRESH_TOKEN_TTL_SECONDS,
      "DEVSPACE_OAUTH_REFRESH_TOKEN_TTL_SECONDS",
    ),
    scopes: parseStringList(env.DEVSPACE_OAUTH_SCOPES, [LEGACY_OAUTH_SCOPE]),
    allowedRedirectHosts: parseStringList(env.DEVSPACE_OAUTH_ALLOWED_REDIRECT_HOSTS, [
      "chatgpt.com",
      "localhost",
      "127.0.0.1",
    ]),
    maxRegisteredClients: parsePositiveInteger(
      env.DEVSPACE_OAUTH_MAX_REGISTERED_CLIENTS,
      DEFAULT_OAUTH_MAX_REGISTERED_CLIENTS,
      "DEVSPACE_OAUTH_MAX_REGISTERED_CLIENTS",
    ),
    inactiveClientMaxAgeSeconds: parsePositiveInteger(
      env.DEVSPACE_OAUTH_INACTIVE_CLIENT_MAX_AGE_DAYS,
      DEFAULT_OAUTH_INACTIVE_CLIENT_MAX_AGE_DAYS,
      "DEVSPACE_OAUTH_INACTIVE_CLIENT_MAX_AGE_DAYS",
    ) * 24 * 60 * 60,
    authorizationRateLimit: {
      maxFailures: parsePositiveInteger(
        env.DEVSPACE_OAUTH_AUTH_FAILURE_LIMIT,
        DEFAULT_OAUTH_AUTH_FAILURE_LIMIT,
        "DEVSPACE_OAUTH_AUTH_FAILURE_LIMIT",
      ),
      failureWindowMs: parsePositiveInteger(
        env.DEVSPACE_OAUTH_AUTH_FAILURE_WINDOW_SECONDS,
        DEFAULT_OAUTH_AUTH_FAILURE_WINDOW_SECONDS,
        "DEVSPACE_OAUTH_AUTH_FAILURE_WINDOW_SECONDS",
      ) * 1_000,
      blockDurationMs: parsePositiveInteger(
        env.DEVSPACE_OAUTH_AUTH_BLOCK_SECONDS,
        DEFAULT_OAUTH_AUTH_BLOCK_SECONDS,
        "DEVSPACE_OAUTH_AUTH_BLOCK_SECONDS",
      ) * 1_000,
      failureDelayMs: parseNonNegativeInteger(
        env.DEVSPACE_OAUTH_AUTH_FAILURE_DELAY_MS,
        DEFAULT_OAUTH_AUTH_FAILURE_DELAY_MS,
        "DEVSPACE_OAUTH_AUTH_FAILURE_DELAY_MS",
      ),
    },
  };
}

function defaultStateDir(): string {
  return join(homedir(), ".local", "share", "devspace");
}

function defaultWorktreeRoot(): string {
  return join(homedir(), ".devspace", "worktrees");
}

function defaultAgentDir(): string {
  return join(homedir(), ".codex");
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const files = loadDevspaceFiles(env);
  const host = env.HOST ?? files.config.host ?? "127.0.0.1";
  const port = parsePort(env.PORT ?? files.config.port);
  const publicBaseUrl = parsePublicBaseUrl(
    env.DEVSPACE_PUBLIC_BASE_URL ?? files.config.publicBaseUrl ?? localPublicBaseUrl(host, port),
  );
  const stateDir = resolve(expandHomePath(env.DEVSPACE_STATE_DIR ?? files.config.stateDir ?? defaultStateDir()));
  const derivedAllowedHosts = [
    "localhost",
    "127.0.0.1",
    "::1",
    host,
    new URL(publicBaseUrl).hostname,
    ...(files.config.allowedHosts ?? []),
  ];

  return {
    host,
    port,
    oauth: parseOAuthConfig(env, files.auth.ownerToken),
    allowedRoots: parseAllowedRoots(env.DEVSPACE_ALLOWED_ROOTS ?? files.config.allowedRoots),
    allowedHosts: parseAllowedHosts(env.DEVSPACE_ALLOWED_HOSTS, derivedAllowedHosts),
    publicBaseUrl,
    toolMode: "codex",
    experimentalFeatures: ["command_metadata"],
    workspaceTasksEnabled: true,
    workspaceTaskDynamicArgsEnabled: false,
    sandboxBundleEnabled: false,
    sandboxBundlePolicyEnabled: false,
    widgets: "off",
    stateDir,
    worktreeRoot: resolve(expandHomePath(env.DEVSPACE_WORKTREE_ROOT ?? files.config.worktreeRoot ?? defaultWorktreeRoot())),
    artifactsEnabled: true,
    artifactMaxFileBytes: parsePositiveInteger(
      env.DEVSPACE_ARTIFACT_MAX_FILE_BYTES ?? numberConfigValue(files.config.artifactMaxFileBytes),
      DEFAULT_ARTIFACT_MAX_FILE_BYTES,
      "DEVSPACE_ARTIFACT_MAX_FILE_BYTES",
    ),
    skillsEnabled: true,
    skillPaths: parsePathList(env.DEVSPACE_SKILL_PATHS),
    devspaceSkillsDir: devspaceSkillsDir(env),
    devspaceAgentsDir: devspaceAgentsDir(env),
    subagents: false,
    agentDir: resolve(expandHomePath(env.DEVSPACE_AGENT_DIR ?? files.config.agentDir ?? defaultAgentDir())),
    workspaceSessionMaxAgeMs: parsePositiveInteger(
      env.DEVSPACE_WORKSPACE_SESSION_MAX_AGE_DAYS,
      DEFAULT_WORKSPACE_SESSION_MAX_AGE_DAYS,
      "DEVSPACE_WORKSPACE_SESSION_MAX_AGE_DAYS",
    ) * 24 * 60 * 60 * 1_000,
    logging: parseLoggingConfig(env, stateDir),
  };
}

function numberConfigValue(value: number | undefined): string | undefined {
  return value === undefined ? undefined : String(value);
}

function parsePublicBaseUrl(value: string): string {
  const parsed = new URL(value);
  parsed.hash = "";
  parsed.search = "";
  parsed.pathname = parsed.pathname.replace(/\/+$/, "");
  return parsed.toString().replace(/\/$/, "");
}

function localPublicBaseUrl(host: string, port: number): string {
  const publicHost = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
  const formattedHost = publicHost.includes(":") && !publicHost.startsWith("[")
    ? `[${publicHost}]`
    : publicHost;
  return `http://${formattedHost}:${port}`;
}
