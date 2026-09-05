import { appendFileSync, existsSync, mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { PRODUCT_DISPLAY_NAME } from "./branding.js";
import type { LoggingConfig } from "./logger.js";
import { sanitizeMonitorCommand } from "./monitor-operation-context.js";

export type HttpRequestClassification = "request" | "auth" | "probe" | "error";

type LogFields = Record<string, unknown>;

export type LoggedCommandKind = "graft" | "rg" | "mixed";
export type LoggedGraftCommandAction = "build" | "map" | "ask" | "callers" | "skeleton" | "grep" | "other";

export interface WorkbridgeToolUsageLogEntry {
  tool: string;
  workspaceId?: string;
  operationId?: string;
  success: boolean;
  durationMs: number;
  action?: string;
  commandKind?: LoggedCommandKind;
  commandAction?: LoggedGraftCommandAction;
}

const initializedLogDirectories = new Set<string>();
const TOOL_USAGE_LOG_MAX_BYTES = 5 * 1024 * 1024;
const TOOL_USAGE_LOG_MAX_FILES = 5;
const TOOL_USAGE_TOOLS = new Set(["exec_command", "run_semantic_action", "read", "apply_patch"]);

export function sanitizeRequestUrlForLog(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const parsed = new URL(value);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return value.split(/[?#]/, 1)[0];
  }
}

export function writeWorkbridgeJsonlLog(config: LoggingConfig, entry: LogFields): void {
  if (!config.file || !config.filePath) return;

  try {
    const directory = dirname(config.filePath);
    if (!initializedLogDirectories.has(directory)) {
      mkdirSync(directory, { recursive: true });
      initializedLogDirectories.add(directory);
    }
    const line = `${JSON.stringify(entry)}\n`;
    rotateJsonlLogIfNeeded(
      config.filePath,
      config.fileMaxBytes,
      config.fileMaxFiles,
      Buffer.byteLength(line, "utf8"),
    );
    appendFileSync(config.filePath, line, "utf8");
  } catch (error) {
    process.stderr.write(
      `[${PRODUCT_DISPLAY_NAME.toLowerCase()}] failed to write log file ${JSON.stringify(config.filePath)}: ${error instanceof Error ? error.message : String(error)}\n`,
    );
  }
}

export function writeWorkbridgeToolUsageLog(
  config: LoggingConfig,
  entry: WorkbridgeToolUsageLogEntry,
): void {
  if (!config.file || !config.filePath || !TOOL_USAGE_TOOLS.has(entry.tool)) return;

  const filePath = toolUsageLogPath(config.filePath);
  try {
    const directory = dirname(filePath);
    if (!initializedLogDirectories.has(directory)) {
      mkdirSync(directory, { recursive: true });
      initializedLogDirectories.add(directory);
    }
    const line = `${JSON.stringify({ ts: new Date().toISOString(), schemaVersion: 1, ...entry })}\n`;
    rotateJsonlLogIfNeeded(
      filePath,
      TOOL_USAGE_LOG_MAX_BYTES,
      TOOL_USAGE_LOG_MAX_FILES,
      Buffer.byteLength(line, "utf8"),
    );
    appendFileSync(filePath, line, "utf8");
  } catch (error) {
    process.stderr.write(
      `[${PRODUCT_DISPLAY_NAME.toLowerCase()}] failed to write tool usage log: ${error instanceof Error ? error.message : String(error)}\n`,
    );
  }
}

export function classifyHttpRequest(
  path: string,
  status: number | undefined,
): HttpRequestClassification {
  if ((status === 401 || status === 403) && path === "/mcp") return "auth";
  if (
    status === 404
    && (
      path.startsWith("/.well-known/")
      || path === "/mcp/.well-known/oauth-authorization-server"
    )
  ) return "probe";
  if (status !== undefined && status >= 400) return "error";
  return "request";
}

export function shouldSuppressSuccessfulMonitorPoll(
  method: string,
  path: string,
  status: number | undefined,
  abnormal: boolean,
): boolean {
  return method === "GET"
    && !abnormal
    && status !== undefined
    && status >= 200
    && status < 300
    && (path === "/monitor/api/snapshot" || path === "/monitor/api/status");
}

export function compactClientKind(userAgent: unknown): string {
  const value = typeof userAgent === "string" ? userAgent.toLowerCase() : "";
  if (value.includes("openai")) return "openai";
  if (value.includes("claude") || value.includes("anthropic")) return "claude";
  if (userAgentIncludesAny(value, ["aiohttp", "python-requests", "python", "urllib", "httpx"])) return "python";
  if (userAgentIncludesAny(value, ["curl", "wget"])) return "curl";
  if (userAgentIncludesAny(value, ["nmap", "masscan", "nikto", "sqlmap", "nuclei", "zgrab", "censys", "shodan"])) return "scanner";
  if (userAgentIncludesAny(value, ["mozilla", "chrome", "safari", "firefox", "edg/"])) return "browser";
  return "unknown";
}

export function workspaceIdDisplayToken(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") return "----------";
  const normalized = value.startsWith("ws_") ? value.slice(3) : value;
  return normalized.length <= 10 ? normalized : normalized.slice(0, 10);
}

export function loggedCommandFields(
  config: Pick<LoggingConfig, "shellCommands">,
  tool: string,
  command: string | undefined,
  commandLength?: number,
): {
  commandPreview?: string;
  commandLength?: number;
  commandKind?: LoggedCommandKind;
  commandAction?: LoggedGraftCommandAction;
} {
  const usageFields = commandUsageFields(tool, command);
  if (!config.shellCommands || !command || !isShellCommandTool(tool)) return usageFields;
  return {
    ...usageFields,
    commandPreview: normalizeCommandPreview(command),
    commandLength: commandLength ?? command.length,
  };
}

export function commandUsageFields(
  tool: string,
  command: string | undefined,
): { commandKind?: LoggedCommandKind; commandAction?: LoggedGraftCommandAction } {
  if (!command || !isShellCommandTool(tool)) return {};

  const graftMatch = command.match(
    /(?:^|(?:&&|\|\||[&|;])\s*)(?:npx(?:\.cmd|\.exe)?\s+(?:(?:-y|--yes)\s+)?@nanonets\/graft(?:@[^\s"'&|;]+)?|graft(?:\.cmd|\.exe)?)(?=\s|$)/i,
  );
  const hasRg = /(?:^|(?:&&|\|\||[&|;])\s*)rg(?:\.exe)?(?=\s|$)/i.test(command);

  if (!graftMatch && !hasRg) return {};

  const commandKind: LoggedCommandKind = graftMatch && hasRg
    ? "mixed"
    : graftMatch
      ? "graft"
      : "rg";
  if (!graftMatch) return { commandKind };

  return {
    commandKind,
    commandAction: graftCommandAction(command.slice((graftMatch.index ?? 0) + graftMatch[0].length)),
  };
}

function rotateJsonlLogIfNeeded(
  filePath: string,
  maxBytes: number | undefined,
  maxFiles: number,
  incomingBytes: number,
): void {
  if (maxBytes === undefined || !existsSync(filePath)) return;

  const currentBytes = statSync(filePath).size;
  if (currentBytes + incomingBytes <= maxBytes) return;

  if (maxFiles <= 1) {
    rmSync(filePath, { force: true });
    return;
  }

  for (let index = maxFiles - 1; index >= 1; index -= 1) {
    const source = index === 1 ? filePath : `${filePath}.${index - 1}`;
    const target = `${filePath}.${index}`;
    if (!existsSync(source)) continue;
    rmSync(target, { force: true });
    renameSync(source, target);
  }
}

function normalizeCommandPreview(command: string): string {
  const normalized = (sanitizeMonitorCommand(command).commandDisplay ?? "")
    .replace(/\s+/g, " ")
    .trim();
  return normalized.length > 120 ? `${normalized.slice(0, 117)}...` : normalized;
}

function graftCommandAction(commandTail: string): LoggedGraftCommandAction {
  const actions = new Set<LoggedGraftCommandAction>(["build", "map", "ask", "callers", "skeleton", "grep"]);
  const tokens = commandTail.match(/"[^"]*"|'[^']*'|[^\s]+/g) ?? [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]?.replace(/^(?:"|')|(?:"|')$/g, "") ?? "";
    if (token === "--dir") {
      index += 1;
      continue;
    }
    if (token.startsWith("--dir=") || token.startsWith("-")) continue;
    return actions.has(token as LoggedGraftCommandAction)
      ? token as LoggedGraftCommandAction
      : "other";
  }
  return "other";
}

function toolUsageLogPath(filePath: string): string {
  return filePath.toLowerCase().endsWith(".jsonl")
    ? `${filePath.slice(0, -6)}-tool-usage.jsonl`
    : `${filePath}-tool-usage.jsonl`;
}

function isShellCommandTool(tool: string): boolean {
  return tool === "exec_command" || tool === "bash" || tool === "run_workspace_action";
}

function userAgentIncludesAny(value: string, needles: string[]): boolean {
  return needles.some((needle) => value.includes(needle));
}
