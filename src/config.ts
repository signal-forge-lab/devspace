import { join, resolve } from "node:path";
import type { ToolMode } from "./config-schema.js";
import { expandHomePath } from "./roots.js";
import type { LoggingConfig } from "./logger.js";
import type { OAuthConfig } from "./oauth-provider.js";
import {
  deriveClientRegistrationKey,
  devspaceAgentsDir,
  devspaceSkillsDir,
  loadDevspaceFiles,
} from "./user-config.js";
import type { SubagentsConfig } from "./local-agent-config.js";
import {
  WORKBRIDGE_SUBAGENTS_ENABLED,
  WORKBRIDGE_UPSTREAM_TOOL_MODE,
  WORKBRIDGE_WIDGET_MODE,
} from "./workbridge-tool-policy.js";
import {
  configProvenance,
  type WorkbridgeConfigProvenance,
} from "./workbridge-config-provenance.js";
import { assertWorktreeRootInsideProjectRoots } from "./workbridge-root-policy.js";

export type { ToolMode } from "./config-schema.js";
export type WidgetMode = "off" | "changes" | "full";
export type WorkbridgeMcpConnectionMode = "public-url" | "openai-secure-mcp-tunnel";

const DEFAULT_WORKSPACE_SESSION_MAX_AGE_DAYS = 30;
const UPSTREAM_DEFAULT_WORKTREE_ROOT = "~/.devspace/worktrees";

export interface ServerConfig {
  configDir: string;
  host: string;
  port: number;
  monitorPort: number;
  oauth?: OAuthConfig;
  allowedRoots: string[];
  auxiliaryRoots: string[];
  allowedHosts: string[];
  publicBaseUrl: string;
  mcpConnectionMode: WorkbridgeMcpConnectionMode;
  toolMode: ToolMode;
  uiEnabled: boolean;
  widgets: WidgetMode;
  stateDir: string;
  worktreeRoot: string;
  artifactsEnabled: boolean;
  artifactMaxFileBytes: number;
  skillsEnabled: boolean;
  skillPaths: string[];
  devspaceSkillsDir: string;
  devspaceAgentsDir: string;
  subagents: SubagentsConfig;
  agentDir: string;
  workspaceSessionMaxAgeMs: number;
  logging: LoggingConfig;
  provenance?: WorkbridgeConfigProvenance;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const files = loadDevspaceFiles(env);
  const stored = files.config;
  const host = env.HOST?.trim() || stored.server.host;
  const port = parsePort(env.PORT, stored.server.port, "PORT");
  const monitorPort = parseMonitorPort(env.WORKBRIDGE_MONITOR_PORT, stored.server.monitorPort, port);
  const publicBaseUrl = parsePublicBaseUrl(
    env.DEVSPACE_PUBLIC_BASE_URL ?? stored.server.publicBaseUrl ?? localPublicBaseUrl(host, port),
  );
  const mcpConnectionMode = parseMcpConnectionMode(
    env.WORKBRIDGE_MCP_CONNECTION_MODE ?? stored.server.mcpConnectionMode,
  );
  if (mcpConnectionMode === "openai-secure-mcp-tunnel" && !isLoopbackHost(host)) {
    throw new Error("Secure MCP Tunnel mode requires a loopback host.");
  }

  const allowedRoots = env.DEVSPACE_ALLOWED_ROOTS
    ? normalizePaths(splitList(env.DEVSPACE_ALLOWED_ROOTS), [process.cwd()])
    : normalizePaths(stored.workspaces.allowedRoots, [process.cwd()]);
  const auxiliaryRoots = env.WORKBRIDGE_AUXILIARY_ROOTS
    ? normalizePaths(splitList(env.WORKBRIDGE_AUXILIARY_ROOTS))
    : normalizePaths(stored.workspaces.auxiliaryRoots);
  const stateDir = normalizePath(env.DEVSPACE_STATE_DIR ?? stored.storage.stateDir);
  const configuredWorktreeRoot = env.DEVSPACE_WORKTREE_ROOT
    ?? (stored.workspaces.worktreeRoot === UPSTREAM_DEFAULT_WORKTREE_ROOT
      ? join(allowedRoots[0]!, ".workbridge", "worktrees")
      : stored.workspaces.worktreeRoot);
  const worktreeRoot = assertWorktreeRootInsideProjectRoots(
    normalizePath(configuredWorktreeRoot),
    allowedRoots,
  );
  const trustProxy = env.DEVSPACE_TRUST_PROXY === undefined
    ? stored.server.trustProxy
    : parseBoolean(env.DEVSPACE_TRUST_PROXY);
  const derivedAllowedHosts = [
    "localhost",
    "127.0.0.1",
    "::1",
    host,
    new URL(publicBaseUrl).hostname,
    ...stored.server.allowedHosts,
  ];
  const ownerToken = env.DEVSPACE_OAUTH_OWNER_TOKEN ?? files.auth.ownerToken;

  return {
    configDir: files.dir,
    host,
    port,
    monitorPort,
    oauth: mcpConnectionMode === "openai-secure-mcp-tunnel"
      ? undefined
      : createOAuthConfig(env, stored.oauth, ownerToken, files.auth.clientRegistrationKey),
    allowedRoots,
    auxiliaryRoots,
    allowedHosts: env.DEVSPACE_ALLOWED_HOSTS
      ? normalizeAllowedHosts(splitList(env.DEVSPACE_ALLOWED_HOSTS))
      : normalizeAllowedHosts(derivedAllowedHosts),
    publicBaseUrl,
    mcpConnectionMode,
    toolMode: WORKBRIDGE_UPSTREAM_TOOL_MODE,
    uiEnabled: false,
    widgets: WORKBRIDGE_WIDGET_MODE,
    stateDir,
    worktreeRoot,
    artifactsEnabled: true,
    artifactMaxFileBytes: stored.artifacts.maxFileBytes,
    skillsEnabled: true,
    skillPaths: stored.skills.paths,
    devspaceSkillsDir: devspaceSkillsDir(env),
    devspaceAgentsDir: devspaceAgentsDir(env),
    subagents: { ...stored.subagents, enabled: WORKBRIDGE_SUBAGENTS_ENABLED },
    agentDir: normalizePath(stored.skills.agentDir),
    workspaceSessionMaxAgeMs: parsePositiveInteger(
      env.DEVSPACE_WORKSPACE_SESSION_MAX_AGE_DAYS,
      DEFAULT_WORKSPACE_SESSION_MAX_AGE_DAYS,
      "DEVSPACE_WORKSPACE_SESSION_MAX_AGE_DAYS",
    ) * 24 * 60 * 60 * 1_000,
    logging: {
      level: stored.logging.level,
      format: stored.logging.format,
      file: env.DEVSPACE_LOG_FILE === undefined ? stored.logging.file : parseBoolean(env.DEVSPACE_LOG_FILE),
      filePath: normalizePath(
        env.DEVSPACE_LOG_FILE_PATH
          ?? stored.logging.filePath
          ?? join(stateDir, "logs", "devspace.jsonl"),
      ),
      fileMaxBytes: stored.logging.fileMaxBytes ?? undefined,
      fileMaxFiles: stored.logging.fileMaxFiles,
      requests: stored.logging.requests,
      assets: stored.logging.assets,
      toolCalls: stored.logging.toolCalls,
      shellCommands: env.WORKBRIDGE_LOG_SHELL_COMMANDS === undefined
        ? stored.logging.shellCommands
        : parseBoolean(env.WORKBRIDGE_LOG_SHELL_COMMANDS),
      trustProxy,
    },
    provenance: configProvenance(env, files),
  };
}

function createOAuthConfig(
  env: NodeJS.ProcessEnv,
  stored: ReturnType<typeof loadDevspaceFiles>["config"]["oauth"],
  ownerToken: string | undefined,
  clientRegistrationKey: string | undefined,
): OAuthConfig {
  const resolvedOwnerToken = parseRequiredSecret(ownerToken, "OAuth owner token", 16);
  return {
    ownerToken: resolvedOwnerToken,
    clientRegistrationKey: parseRequiredSecret(
      env.DEVSPACE_OAUTH_CLIENT_REGISTRATION_KEY
        ?? clientRegistrationKey
        ?? deriveClientRegistrationKey(resolvedOwnerToken),
      "OAuth client registration key",
      32,
    ),
    accessTokenTtlSeconds: stored.accessTokenTtlSeconds,
    refreshTokenTtlSeconds: stored.refreshTokenTtlSeconds,
    scopes: stored.scopes,
    allowedRedirectHosts: stored.allowedRedirectHosts,
    maxRegisteredClients: stored.maxRegisteredClients,
    inactiveClientMaxAgeSeconds: stored.inactiveClientMaxAgeSeconds,
    authorizationRateLimit: {
      maxFailures: stored.authFailureLimit,
      failureWindowMs: stored.authFailureWindowSeconds * 1_000,
      blockDurationMs: stored.authBlockSeconds * 1_000,
      failureDelayMs: stored.authFailureDelayMs,
    },
  };
}

function normalizePaths(paths: string[], fallback: string[] = []): string[] {
  return (paths.length > 0 ? paths : fallback).map(normalizePath);
}

function normalizePath(path: string): string {
  return resolve(expandHomePath(path));
}

function normalizeAllowedHosts(hosts: string[]): string[] {
  if (hosts.includes("*")) return ["*"];
  return Array.from(new Set(hosts.map((host) => host.trim()).filter(Boolean)));
}

function splitList(value: string): string[] {
  return value.split(",").map((entry) => entry.trim()).filter(Boolean);
}

function parseBoolean(value: string | undefined): boolean {
  return ["1", "true", "yes", "on"].includes(value?.trim().toLowerCase() ?? "");
}

function parsePort(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined || value === "") return fallback;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error(`Invalid ${name}: ${value}`);
  return port;
}

function parseMonitorPort(value: string | undefined, configured: number | null, serverPort: number): number {
  const fallback = configured ?? (serverPort === 65_535 ? 65_534 : serverPort + 1);
  const port = parsePort(value, fallback, "WORKBRIDGE_MONITOR_PORT");
  if (port === serverPort) throw new Error("WORKBRIDGE_MONITOR_PORT must differ from PORT.");
  return port;
}

function parseMcpConnectionMode(value: string | undefined): WorkbridgeMcpConnectionMode {
  if (!value || value === "public-url") return "public-url";
  if (value === "openai-secure-mcp-tunnel") return value;
  throw new Error(`Invalid WORKBRIDGE_MCP_CONNECTION_MODE: ${value}`);
}

function parsePositiveInteger(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`Invalid ${name}: ${value}`);
  return parsed;
}

function parseRequiredSecret(value: string | undefined, label: string, minimumLength: number): string {
  const secret = value?.trim();
  if (!secret) throw new Error(`${label} is required. Run: devspace init`);
  if (secret.length < minimumLength) throw new Error(`${label} must be at least ${minimumLength} characters long.`);
  return secret;
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
  const formattedHost = publicHost.includes(":") && !publicHost.startsWith("[") ? `[${publicHost}]` : publicHost;
  return `http://${formattedHost}:${port}`;
}

function isLoopbackHost(host: string): boolean {
  return ["127.0.0.1", "localhost", "::1", "[::1]"].includes(host.trim().toLowerCase());
}
