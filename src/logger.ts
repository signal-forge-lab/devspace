import { appendFileSync, existsSync, mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import { dirname } from "node:path";
import type { Request } from "express";
import { PRODUCT_DISPLAY_NAME } from "./branding.js";

export type LogLevel = "silent" | "error" | "warn" | "info" | "debug";
export type LogFormat = "json" | "pretty";
export type HttpRequestClassification = "request" | "auth" | "probe" | "error";

export interface LoggingConfig {
  level: LogLevel;
  format: LogFormat;
  file: boolean;
  filePath?: string;
  fileMaxBytes?: number;
  fileMaxFiles: number;
  consoleJson: boolean;
  requests: boolean;
  assets: boolean;
  toolCalls: boolean;
  shellCommands: boolean;
  trustProxy: boolean;
}

type LogFields = Record<string, unknown>;

const initializedLogDirectories = new Set<string>();

const COMPACT_SUCCESS_TOOL_NAMES = new Set([
  "read",
  "grep",
  "glob",
  "ls",
  "edit",
  "write",
  "apply_patch",
  "bash",
  "exec_command",
  "write_stdin",
  "run_workspace_action",
]);

const COMPACT_LABEL_WIDTH = 7;
const COMPACT_EVENT_WIDTH = 19;
const COMPACT_STATUS_WIDTH = 7;

const ANSI_RED = "\x1b[31m";
const ANSI_YELLOW = "\x1b[33m";
const ANSI_CYAN = "\x1b[36m";
const ANSI_RESET = "\x1b[0m";

const LEVEL_WEIGHT: Record<LogLevel, number> = {
  silent: 0,
  error: 1,
  warn: 2,
  info: 3,
  debug: 4,
};

export function shouldLog(config: LoggingConfig, level: Exclude<LogLevel, "silent">): boolean {
  return LEVEL_WEIGHT[config.level] >= LEVEL_WEIGHT[level];
}

export function sanitizeRequestUrlForLog(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const parsed = new URL(value);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return value.split(/[?#]/, 1)[0];
  }
}

export function logEvent(
  config: LoggingConfig,
  level: Exclude<LogLevel, "silent">,
  event: string,
  fields: LogFields = {},
): void {
  if (!shouldLog(config, level)) return;

  const entry = {
    ts: new Date().toISOString(),
    level,
    event,
    ...fields,
  };
  writeJsonlLog(config, entry);

  const compactToolLine = compactToolCallConsoleLine(fields);
  if (compactToolLine) {
    writeConsoleLine(level, compactToolLine);
    return;
  }

  const compactHttpLine = compactHttpRequestConsoleLine(event, fields);
  if (compactHttpLine) {
    writeConsoleLine(level, compactHttpLine);
    return;
  }

  const compactMcpSessionLine = compactMcpSessionConsoleLine(event, fields);
  if (compactMcpSessionLine) {
    writeConsoleLine(level, compactMcpSessionLine);
    return;
  }

  if (!config.consoleJson) return;
  const line = config.format === "pretty" ? formatPretty(entry) : JSON.stringify(entry);
  writeConsoleLine(level, line);
}

function writeJsonlLog(config: LoggingConfig, entry: LogFields): void {
  if (!config.file || !config.filePath) return;

  try {
    const directory = dirname(config.filePath);
    if (!initializedLogDirectories.has(directory)) {
      mkdirSync(directory, { recursive: true });
      initializedLogDirectories.add(directory);
    }
    const line = `${JSON.stringify(entry)}\n`;
    rotateJsonlLogIfNeeded(config.filePath, config.fileMaxBytes, config.fileMaxFiles, Buffer.byteLength(line, "utf8"));
    appendFileSync(config.filePath, line, "utf8");
  } catch (error) {
    process.stderr.write(
      `[${PRODUCT_DISPLAY_NAME.toLowerCase()}] failed to write log file ${JSON.stringify(config.filePath)}: ${error instanceof Error ? error.message : String(error)}\n`,
    );
  }
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

function writeConsoleLine(level: Exclude<LogLevel, "silent">, line: string): void {
  if (level === "error") {
    console.error(line);
  } else if (level === "warn") {
    console.warn(line);
  } else {
    console.log(line);
  }
}

function compactToolCallConsoleLine(fields: LogFields): string | undefined {
  if (fields.tool === undefined || fields.success === undefined) return undefined;

  const tool = String(fields.tool);
  const success = fields.success === true;
  const skipped = fields.executed === false;
  const important = skipped
    || !success
    || fields.error !== undefined
    || fields.truncated === true
    || fields.outputTruncated === true
    || fields.timedOut === true;

  if (!important && !COMPACT_SUCCESS_TOOL_NAMES.has(tool)) return undefined;

  const label = skipped ? "SKIP" : success ? compactOperationLabel(tool) : "FAIL";
  const duration = formatDurationMs(fields.durationMs);
  const line = [
    compactCell(compactTimestamp(), 14),
    compactCell(workspaceIdCompactPrefix(fields.workspaceId), 15),
    compactCell(label, COMPACT_LABEL_WIDTH),
    compactCell(tool, COMPACT_EVENT_WIDTH),
    compactCell(skipped ? "skip" : success ? "ok" : "failed", COMPACT_STATUS_WIDTH),
    compactDurationCell(duration, success),
    compactDetailFields(fields, success),
  ].filter(Boolean).join(" | ");
  return skipped
    ? colorizeConsoleLine(line, "yellow")
    : success
      ? line
      : colorizeConsoleLine(line, "red");
}

function compactHttpRequestConsoleLine(event: string, fields: LogFields): string | undefined {
  if (event !== "http_request") return undefined;

  const path = stringField(fields.path) ?? "unknown";
  const status = numberField(fields.status);
  const durationMs = numberField(fields.durationMs);
  const shouldShow = path === "/mcp"
    || (status !== undefined && status >= 400)
    || (durationMs !== undefined && durationMs >= 1000);
  if (!shouldShow) return undefined;

  const classification = isHttpRequestClassification(fields.classification)
    ? fields.classification
    : classifyHttpRequest(path, status);
  const success = classification !== "error";
  const label = classification === "auth" ? "AUTH" : classification === "probe" ? "PROBE" : "HTTP";
  const statusLabel = classification === "auth"
    ? "auth"
    : classification === "probe"
      ? "probe"
      : success
        ? "ok"
        : "failed";
  const duration = formatDurationMs(durationMs);
  const line = [
    compactCell(compactTimestamp(), 14),
    compactCell(httpWorkspaceColumn(fields), 15),
    compactCell(label, COMPACT_LABEL_WIDTH),
    compactCell("http_request", COMPACT_EVENT_WIDTH),
    compactCell(statusLabel, COMPACT_STATUS_WIDTH),
    compactDurationCell(duration, success),
    compactHttpDetails(fields, path, status, durationMs),
  ].filter(Boolean).join(" | ");

  return success ? colorizeConsoleLine(line, "cyan") : colorizeConsoleLine(line, "red");
}

function compactMcpSessionConsoleLine(event: string, fields: LogFields): string | undefined {
  if (
    event !== "mcp_session_metrics"
    && event !== "mcp_session_metrics_startup"
    && event !== "mcp_session_pressure"
  ) {
    return undefined;
  }

  const active = numberField(fields.active) ?? 0;
  const activeRequests = numberField(fields.activeRequests) ?? 0;
  const initializedOnly = numberField(fields.initializedOnly) ?? 0;
  const handshakeOnly = numberField(fields.handshakeOnly) ?? 0;
  const discoveryOnly = numberField(fields.discoveryOnly) ?? 0;
  const operational = numberField(fields.operational) ?? 0;
  const toolCallSessions = numberField(fields.toolCallSessions) ?? 0;
  const oneShotCleanupCandidates = numberField(fields.oneShotCleanupCandidates) ?? 0;
  const reusedToolCallSessions = numberField(fields.reusedToolCallSessions) ?? 0;
  const maxToolCallsPerSession = numberField(fields.maxToolCallsPerSession) ?? 0;
  const rss = formatMemoryBytes(numberField(fields.rssBytes));
  const heap = formatMemoryBytes(numberField(fields.heapUsedBytes));
  const label = event === "mcp_session_pressure" ? "MCPWARN" : "MCPSESS";
  const status = event === "mcp_session_pressure" ? "warning" : "ok";
  const details = [
    `active=${active}`,
    `requests=${activeRequests}`,
    `init=${initializedOnly}`,
    `handshake=${handshakeOnly}`,
    `discovery=${discoveryOnly}`,
    `operational=${operational}`,
    `toolSessions=${toolCallSessions}`,
    `oneShot=${oneShotCleanupCandidates}`,
    `reused=${reusedToolCallSessions}`,
    `maxCalls=${maxToolCallsPerSession}`,
    rss ? `rss=${rss}` : undefined,
    heap ? `heap=${heap}` : undefined,
    event === "mcp_session_pressure" ? `threshold=${numberField(fields.threshold) ?? "?"}` : undefined,
  ].filter(Boolean).join(" ");
  const line = [
    compactCell(compactTimestamp(), 14),
    compactCell("mcp", 15),
    compactCell(label, COMPACT_LABEL_WIDTH),
    compactCell("sessions", COMPACT_EVENT_WIDTH),
    compactCell(status, COMPACT_STATUS_WIDTH),
    details,
  ].join(" | ");
  return event === "mcp_session_pressure" ? colorizeConsoleLine(line, "red") : line;
}

function formatMemoryBytes(value: number | undefined): string | undefined {
  if (value === undefined) return undefined;
  return `${(value / (1024 * 1024)).toFixed(1)}MiB`;
}

export function classifyHttpRequest(
  path: string,
  status: number | undefined,
): HttpRequestClassification {
  if ((status === 401 || status === 403) && path === "/mcp") return "auth";
  if (status === 404 && path.startsWith("/.well-known/")) return "probe";
  if (status !== undefined && status >= 400) return "error";
  return "request";
}

function isHttpRequestClassification(value: unknown): value is HttpRequestClassification {
  return value === "request" || value === "auth" || value === "probe" || value === "error";
}

function compactHttpDetails(fields: LogFields, path: string, status: number | undefined, durationMs: number | undefined): string {
  const parts: string[] = [];
  parts.push(`${stringField(fields.method) ?? "?"} ${path}`);
  pushCompactField(parts, "code", status);
  pushCompactField(parts, "bytes", fields.contentLength);
  pushCompactField(parts, "client", compactClientKind(fields.userAgent));
  pushCompactFlag(parts, "slow", durationMs !== undefined && durationMs >= 1000);
  return parts.join(" ");
}

function httpWorkspaceColumn(fields: LogFields): string {
  return stringField(fields.workspaceId) !== undefined
    ? workspaceIdCompactPrefix(fields.workspaceId)
    : stringField(fields.ip) ?? "---------------";
}

function compactOperationLabel(tool: string): string {
  if (tool === "run_workspace_action") return "ACTION";
  if (tool === "exec_command" || tool === "bash" || tool === "write_stdin") return "RUN";
  if (tool === "read" || tool === "grep" || tool === "glob" || tool === "ls") return "READ";
  if (tool === "edit" || tool === "write" || tool === "apply_patch") return "CHANGE";
  return "CHANGE";
}

function formatDurationMs(value: unknown): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "unknown";
  if (value < 1000) return `${Math.round(value)}ms`;
  if (value < 60_000) return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)}s`;
  const minutes = Math.floor(value / 60_000);
  const seconds = Math.round((value % 60_000) / 1000);
  return `${minutes}m${String(seconds).padStart(2, "0")}s`;
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numberField(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
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

function userAgentIncludesAny(value: string, needles: string[]): boolean {
  return needles.some((needle) => value.includes(needle));
}

function compactCell(value: string, width: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  const clipped = normalized.length > width ? `${normalized.slice(0, Math.max(0, width - 1))}…` : normalized;
  return clipped.padEnd(width, " ");
}

function compactTimestamp(date = new Date()): string {
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  const seconds = String(date.getSeconds()).padStart(2, "0");
  return `${month}/${day} ${hours}:${minutes}:${seconds}`;
}

function workspaceIdCompactPrefix(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") return "----------";
  const normalized = value.startsWith("ws_") ? value.slice(3) : value;
  return normalized.slice(0, 10);
}

function compactDurationCell(duration: string, success: boolean): string {
  const cell = compactCell(duration, 8);
  if (!success || !durationShouldHighlight(duration)) return cell;
  return colorizeConsoleLine(cell, "yellow");
}

function durationShouldHighlight(duration: string): boolean {
  return /s$/.test(duration) && !duration.endsWith("ms");
}

function compactDetailFields(fields: LogFields, success: boolean): string {
  const parts: string[] = [];
  pushCompactField(parts, "path", fields.path);
  pushCompactField(parts, "files", fields.fileCount ?? fields.affectedFiles);
  pushCompactField(parts, "+", fields.additions);
  pushCompactField(parts, "-", fields.removals);
  pushCompactField(parts, "exit", fields.exitCode);
  pushCompactField(parts, "proc", fields.sessionId);
  pushCompactField(parts, "cmd", compactCommandPreview(fields));
  pushCompactFlag(parts, "dryRun", fields.dryRun === true);
  pushCompactFlag(parts, "truncated", fields.truncated === true || fields.outputTruncated === true);
  pushCompactField(parts, "chars", compactLargeNumber(fields.resultCharacters));
  pushCompactField(parts, "reason", compactReason(fields.error, success ? 80 : undefined));
  pushCompactField(parts, "action", fields.action);
  pushCompactField(parts, "preset", fields.preset);
  pushCompactField(parts, "policy", fields.executionPolicy);
  return parts.join(" ");
}

function pushCompactField(parts: string[], name: string, value: unknown): void {
  if (value === undefined || value === null || value === "") return;
  parts.push(`${name}=${String(value)}`);
}

function pushCompactFlag(parts: string[], name: string, enabled: boolean): void {
  if (enabled) parts.push(`${name}=true`);
}

function compactLargeNumber(value: unknown): string | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 10_000) return undefined;
  return String(Math.round(value));
}

function compactReason(value: unknown, maxLength?: number): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const text = sanitizeCompactConsoleText(String(value), "reason");
  if (maxLength === undefined) return text;
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(0, maxLength - 3))}...`;
}

function compactCommandPreview(fields: LogFields): string | undefined {
  const tool = typeof fields.tool === "string" ? fields.tool : "";
  if (tool !== "exec_command" && tool !== "bash" && tool !== "write_stdin" && tool !== "run_workspace_action") return undefined;
  const value = fields.command ?? fields.commandPreview ?? fields.cmd;
  if (value === undefined || value === null || value === "") return undefined;
  const text = sanitizeCompactConsoleText(String(value), "cmd");
  if (text.length <= 80) return text;
  return `${text.slice(0, 77)}...`;
}

function sanitizeCompactConsoleText(value: string, fieldName: string): string {
  const text = value.replace(/\s+/g, " ").trim();
  if (!looksMojibake(text)) return text;
  return `[${fieldName}:garbled-output]`;
}

function looksMojibake(value: string): boolean {
  const replacementCount = (value.match(/�/g) ?? []).length;
  if (replacementCount >= 3) return true;
  if (replacementCount > 0 && replacementCount / Math.max(value.length, 1) >= 0.05) return true;
  return false;
}

function colorizeConsoleLine(value: string, color: "red" | "yellow" | "cyan"): string {
  if (!shouldColorizeConsole()) return value;
  const prefix = color === "red" ? ANSI_RED : color === "yellow" ? ANSI_YELLOW : ANSI_CYAN;
  return `${prefix}${value}${ANSI_RESET}`;
}

function shouldColorizeConsole(): boolean {
  if (process.env.NO_COLOR !== undefined) return false;
  if (process.env.FORCE_COLOR !== undefined && process.env.FORCE_COLOR !== "0") return true;
  return process.stdout.isTTY === true || process.stderr.isTTY === true;
}

export function requestIp(req: Request, trustProxy: boolean): string | undefined {
  if (trustProxy) {
    const cfConnectingIp = firstHeaderValue(req.header("cf-connecting-ip"));
    if (cfConnectingIp) return cfConnectingIp;

    const forwardedFor = firstHeaderValue(req.header("x-forwarded-for"));
    if (forwardedFor) return forwardedFor;
  }

  return req.ip ?? req.socket.remoteAddress;
}

export function requestPath(req: Request): string {
  return req.path || req.url.split("?")[0] || req.url;
}

export function sessionIdPrefix(sessionId: string | undefined): string | undefined {
  return sessionId ? sessionId.slice(0, 8) : undefined;
}

export function commandPreview(command: string): string {
  const normalized = command.replace(/\s+/g, " ").trim();
  return normalized.length > 120 ? `${normalized.slice(0, 117)}...` : normalized;
}

export function loggedCommandFields(
  config: Pick<LoggingConfig, "shellCommands">,
  tool: string,
  command: string | undefined,
  commandLength?: number,
): { commandPreview?: string; commandLength?: number } {
  if (!config.shellCommands || !command || !isShellCommandTool(tool)) return {};
  return {
    commandPreview: commandPreview(command),
    commandLength: commandLength ?? command.length,
  };
}

function isShellCommandTool(tool: string): boolean {
  return tool === "exec_command" || tool === "bash" || tool === "run_workspace_action";
}

function firstHeaderValue(value: string | undefined): string | undefined {
  return value?.split(",")[0]?.trim() || undefined;
}

function formatPretty(entry: LogFields): string {
  const ts = String(entry.ts);
  const level = String(entry.level).toUpperCase();
  const event = String(entry.event);
  const rest = Object.entries(entry)
    .filter(([key, value]) => !["ts", "level", "event"].includes(key) && value !== undefined)
    .map(([key, value]) => `${key}=${formatPrettyValue(value)}`)
    .join(" ");

  return rest ? `${ts} ${level} ${event} ${rest}` : `${ts} ${level} ${event}`;
}

function formatPrettyValue(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value);
  return JSON.stringify(value);
}
