import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { expandHomePath } from "./roots.js";
import type { LoggingConfig, LogFormat, LogLevel } from "./logger.js";
import type { OAuthConfig } from "./oauth-provider.js";
import type { OAuthStaticClientConfig } from "./oauth-store.js";
import { loadWorkbridgeFiles } from "./user-config.js";

export type ToolMode = "minimal" | "full" | "codex" | "main";
export type WidgetMode = "off" | "changes" | "full";
const DEFAULT_OAUTH_ACCESS_TOKEN_TTL_SECONDS = 60 * 60;
const DEFAULT_OAUTH_REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;

export interface ServerConfig {
  host: string;
  port: number;
  oauth: OAuthConfig;
  allowedRoots: string[];
  allowedHosts: string[];
  publicBaseUrl: string;
  toolMode: ToolMode;
  widgets: WidgetMode;
  stateDir: string;
  worktreeRoot: string;
  skillsEnabled: boolean;
  skillPaths: string[];
  agentDir: string;
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

function parseToolMode(env: NodeJS.ProcessEnv): ToolMode {
  const mode = env.DEVSPACE_TOOL_MODE;
  if (mode === "minimal" || mode === "full" || mode === "codex" || mode === "main") return mode;
  if (mode) throw new Error(`Invalid DEVSPACE_TOOL_MODE: ${mode}`);

  if (env.DEVSPACE_MINIMAL_TOOLS !== undefined) {
    return parseBoolean(env.DEVSPACE_MINIMAL_TOOLS) ? "minimal" : "full";
  }
  return "minimal";
}

function parseLogLevel(value: string | undefined, name = "DEVSPACE_LOG_LEVEL"): LogLevel {
  if (!value || value === "info") return "info";
  if (["silent", "error", "warn", "debug"].includes(value)) return value as LogLevel;

  throw new Error(`Invalid ${name}: ${value}`);
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

function defaultLogFileName(date = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return [
    "devspace_",
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    "_",
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds()),
    ".jsonl",
  ].join("");
}

function sanitizeLogFileName(value: string): string {
  const sanitized = value.trim().replace(/[\\/:*?"<>|]+/g, "_");
  return sanitized || defaultLogFileName();
}

function parsePositiveInteger(value: string | undefined, fallback: number, name: string): number {
  if (!value) return fallback;

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`Invalid ${name}: ${value}`);
  }

  return parsed;
}

function parseLoggingConfig(env: NodeJS.ProcessEnv): LoggingConfig {
  const file = env.DEVSPACE_LOG_FILE === undefined ? true : parseBoolean(env.DEVSPACE_LOG_FILE);
  const fileDir = resolve(expandHomePath(env.DEVSPACE_LOG_DIR ?? "logs"));
  const fileName = sanitizeLogFileName(env.DEVSPACE_LOG_FILE_NAME ?? defaultLogFileName());
  return {
    level: parseLogLevel(env.DEVSPACE_LOG_LEVEL),
    consoleLevel: parseLogLevel(env.DEVSPACE_CONSOLE_LOG_LEVEL ?? (file ? "warn" : "info"), "DEVSPACE_CONSOLE_LOG_LEVEL"),
    format: parseLogFormat(env.DEVSPACE_LOG_FORMAT),
    requests: env.DEVSPACE_LOG_REQUESTS === undefined ? true : parseBoolean(env.DEVSPACE_LOG_REQUESTS),
    assets: parseBoolean(env.DEVSPACE_LOG_ASSETS),
    toolCalls: env.DEVSPACE_LOG_TOOL_CALLS === undefined ? true : parseBoolean(env.DEVSPACE_LOG_TOOL_CALLS),
    shellCommands: parseBoolean(env.DEVSPACE_LOG_SHELL_COMMANDS),
    trustProxy: parseBoolean(env.DEVSPACE_TRUST_PROXY),
    file,
    filePath: file ? resolve(fileDir, fileName) : undefined,
  };
}

function parseWidgetMode(value: string | undefined): WidgetMode {
  if (!value || value === "off") return "off";
  if (value === "full" || value === "changes") return value;

  throw new Error(`Invalid DEVSPACE_WIDGETS: ${value}`);
}

function parseRequiredSecret(value: string | undefined, name: string): string {
  const secret = value?.trim();
  if (!secret) {
    throw new Error(`${name} is required for DevSpace OAuth. Run: workbridge init`);
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
    scopes: parseStringList(env.DEVSPACE_OAUTH_SCOPES, ["devspace"]),
    allowedRedirectHosts: parseStringList(env.DEVSPACE_OAUTH_ALLOWED_REDIRECT_HOSTS, [
      "chatgpt.com",
      "claude.ai",
      "anthropic.com",
      "localhost",
      "127.0.0.1",
    ]),
    staticClients: parseOAuthStaticClients(env.DEVSPACE_OAUTH_STATIC_CLIENTS_JSON),
    safeDiagnosticLogging: env.DEVSPACE_OAUTH_SAFE_DIAGNOSTIC_LOGGING === undefined ? true : parseBoolean(env.DEVSPACE_OAUTH_SAFE_DIAGNOSTIC_LOGGING),
  };
}

function parseOAuthStaticClients(value: string | undefined): OAuthStaticClientConfig[] {
  if (!value?.trim()) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new Error(`Invalid DEVSPACE_OAUTH_STATIC_CLIENTS_JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!Array.isArray(parsed)) throw new Error("DEVSPACE_OAUTH_STATIC_CLIENTS_JSON must be a JSON array.");
  return parsed.map((entry, index) => parseOAuthStaticClient(entry, index));
}

function parseOAuthStaticClient(entry: unknown, index: number): OAuthStaticClientConfig {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    throw new Error(`DEVSPACE_OAUTH_STATIC_CLIENTS_JSON[${index}] must be an object.`);
  }
  const record = entry as Record<string, unknown>;
  const clientId = requiredString(record.clientId ?? record.client_id, `DEVSPACE_OAUTH_STATIC_CLIENTS_JSON[${index}].clientId`);
  const redirectUris = parseRedirectUris(record.redirectUris ?? record.redirect_uris, index);
  const allowedScopes = record.allowedScopes === undefined && record.scopes === undefined
    ? undefined
    : parseUnknownStringList(record.allowedScopes ?? record.scopes, `DEVSPACE_OAUTH_STATIC_CLIENTS_JSON[${index}].allowedScopes`);
  return {
    clientId,
    clientName: optionalString(record.clientName ?? record.client_name, `DEVSPACE_OAUTH_STATIC_CLIENTS_JSON[${index}].clientName`),
    redirectUris,
    allowedScopes,
    disabled: Boolean(record.disabled),
  };
}

function parseRedirectUris(value: unknown, index: number): string[] {
  const uris = parseUnknownStringList(value, `DEVSPACE_OAUTH_STATIC_CLIENTS_JSON[${index}].redirectUris`);
  for (const uri of uris) {
    try {
      const parsed = new URL(uri);
      if (parsed.protocol !== "https:" && !["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname)) {
        throw new Error("must use https unless it is localhost");
      }
    } catch (error) {
      throw new Error(`Invalid static OAuth redirect URI ${uri}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return uris;
}

function parseUnknownStringList(value: unknown, name: string): string[] {
  if (Array.isArray(value)) {
    return value.map((entry, index) => requiredString(entry, `${name}[${index}]`));
  }
  if (typeof value === "string") return parseStringList(value, []);
  throw new Error(`${name} must be a string array or comma-separated string.`);
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim().length === 0) throw new Error(`${name} is required.`);
  return value.trim();
}

function optionalString(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error(`${name} must be a string.`);
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
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
  const files = loadWorkbridgeFiles(env);
  const host = env.HOST ?? files.config.host ?? "127.0.0.1";
  const port = parsePort(env.PORT ?? files.config.port);
  const publicBaseUrl = parsePublicBaseUrl(
    env.DEVSPACE_PUBLIC_BASE_URL ?? files.config.publicBaseUrl ?? localPublicBaseUrl(host, port),
  );
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
    toolMode: parseToolMode(env),
    widgets: parseWidgetMode(env.DEVSPACE_WIDGETS),
    stateDir: resolve(expandHomePath(env.DEVSPACE_STATE_DIR ?? files.config.stateDir ?? defaultStateDir())),
    worktreeRoot: resolve(expandHomePath(env.DEVSPACE_WORKTREE_ROOT ?? files.config.worktreeRoot ?? defaultWorktreeRoot())),
    skillsEnabled: env.DEVSPACE_SKILLS === undefined ? true : parseBoolean(env.DEVSPACE_SKILLS),
    skillPaths: parsePathList(env.DEVSPACE_SKILL_PATHS),
    agentDir: resolve(expandHomePath(env.DEVSPACE_AGENT_DIR ?? files.config.agentDir ?? defaultAgentDir())),
    logging: parseLoggingConfig(env),
  };
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
