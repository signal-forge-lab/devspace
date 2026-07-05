import { createHash } from "node:crypto";
import { createWriteStream, mkdirSync, type WriteStream } from "node:fs";
import { dirname } from "node:path";
import type { Request } from "express";
import { appMetadataFields } from "./app-metadata.js";

export type LogLevel = "silent" | "error" | "warn" | "info" | "debug";
export type LogFormat = "json" | "pretty";

export interface LoggingConfig {
  level: LogLevel;
  consoleLevel: LogLevel;
  format: LogFormat;
  requests: boolean;
  assets: boolean;
  toolCalls: boolean;
  shellCommands: boolean;
  trustProxy: boolean;
  file: boolean;
  filePath?: string;
}

type LogFields = Record<string, unknown>;

export const CONVERSATION_ID_HEADER_CANDIDATES = [
  "x-openai-conversation-id",
  "x-chatgpt-conversation-id",
  "openai-conversation-id",
  "chatgpt-conversation-id",
  "x-conversation-id",
  "conversation-id",
  "x-thread-id",
  "thread-id",
  "x-openai-thread-id",
  "x-chatgpt-thread-id",
  "x-openai-chat-id",
  "x-chatgpt-chat-id",
] as const;

export interface RequestCorrelationInput {
  requestId?: string;
  sessionId?: string;
  workspaceId?: string;
}

export interface RequestCorrelationFields extends Record<string, unknown> {
  requestIdPrefix?: string;
  clientKind?: "chatgpt" | "claude" | "unknown";
  sessionIdPrefix?: string;
  conversationIdHeader?: string;
  conversationIdHash?: string;
  autoThreadId: string;
}

const LEVEL_WEIGHT: Record<LogLevel, number> = {
  silent: 0,
  error: 1,
  warn: 2,
  info: 3,
  debug: 4,
};

const COMPACT_SUCCESS_TOOL_NAMES = new Set([
  "edit",
  "write",
  "apply_patch",
  "exec_command",
  "launch_workspace_task",
]);

const fileStreams = new Map<string, WriteStream>();
const failedFilePaths = new Set<string>();

export function shouldLog(config: LoggingConfig, level: Exclude<LogLevel, "silent">): boolean {
  return LEVEL_WEIGHT[config.level] >= LEVEL_WEIGHT[level];
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
    ...appMetadataFields(),
    ...fields,
  };

  writeFileLog(config, entry);

  const compactToolLine = compactToolCallConsoleLine(config, level, fields);
  if (compactToolLine) {
    writeConsoleLine(level, compactToolLine);
    return;
  }

  if (!shouldLog({ ...config, level: config.consoleLevel }, level)) return;

  const line = config.format === "pretty" ? formatPretty(entry) : JSON.stringify(entry);
  writeConsoleLine(level, line);
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

function compactToolCallConsoleLine(
  config: LoggingConfig,
  level: Exclude<LogLevel, "silent">,
  fields: LogFields,
): string | undefined {
  if (config.consoleLevel === "silent") return undefined;
  if (fields.tool === undefined || fields.success === undefined) return undefined;

  const tool = String(fields.tool);
  const success = fields.success === true;
  const important = !success
    || level === "error"
    || level === "warn"
    || fields.error !== undefined
    || fields.truncated === true
    || fields.outputTruncated === true
    || fields.timedOut === true;

  if (!important && !COMPACT_SUCCESS_TOOL_NAMES.has(tool)) return undefined;

  const label = success ? compactOperationLabel(tool) : "失敗";
  return [
    compactCell(String(fields.sessionIdPrefix ?? "--------"), 8),
    compactCell(label, 4),
    compactCell(tool, 22),
    compactCell(success ? "ok" : "failed", 6),
    compactCell(formatDurationMs(fields.durationMs), 8),
    compactDetailFields(fields),
  ].filter(Boolean).join(" | ");
}

function compactOperationLabel(tool: string): string {
  if (tool === "launch_workspace_task") return "タスク";
  if (tool === "exec_command" || tool === "bash" || tool === "write_stdin") return "実行";
  return "変更";
}

function formatDurationMs(value: unknown): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "unknown";
  if (value < 1000) return `${Math.round(value)}ms`;
  if (value < 60_000) return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)}s`;
  const minutes = Math.floor(value / 60_000);
  const seconds = Math.round((value % 60_000) / 1000);
  return `${minutes}m${String(seconds).padStart(2, "0")}s`;
}

function compactCell(value: string, width: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  const clipped = normalized.length > width ? `${normalized.slice(0, Math.max(0, width - 1))}…` : normalized;
  return clipped.padEnd(width, " ");
}

function compactDetailFields(fields: LogFields): string {
  const parts: string[] = [];
  pushCompactField(parts, "path", fields.path);
  pushCompactField(parts, "files", fields.fileCount ?? fields.affectedFiles);
  pushCompactField(parts, "exit", fields.exitCode);
  pushCompactField(parts, "proc", fields.sessionId);
  pushCompactFlag(parts, "dryRun", fields.dryRun === true);
  pushCompactField(parts, "template", fields.template);
  pushCompactFlag(parts, "truncated", fields.truncated === true || fields.outputTruncated === true);
  pushCompactField(parts, "chars", compactLargeNumber(fields.resultCharacters));
  pushCompactField(parts, "reason", compactReason(fields.error));
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

function compactReason(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const text = String(value).replace(/\s+/g, " ").trim();
  return text.length > 80 ? `${text.slice(0, 77)}...` : text;
}

export async function closeLogFiles(): Promise<void> {
  const streams = Array.from(fileStreams.values());
  fileStreams.clear();
  failedFilePaths.clear();
  await Promise.all(streams.map((stream) => new Promise<void>((resolve) => stream.end(resolve))));
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

export function requestCorrelationFields(req: Request, input: RequestCorrelationInput = {}): RequestCorrelationFields {
  const requestIdPrefix = input.requestId?.slice(0, 8);
  const mcpSessionIdPrefix = sessionIdPrefix(input.sessionId);
  const conversation = conversationIdFields(req);
  const autoThreadId = buildAutoThreadId({
    conversationIdHash: conversation.conversationIdHash,
    sessionIdPrefix: mcpSessionIdPrefix,
    workspaceId: input.workspaceId,
    requestIdPrefix,
  });
  return {
    requestIdPrefix,
    clientKind: requestClientKind(req),
    sessionIdPrefix: mcpSessionIdPrefix,
    ...conversation,
    autoThreadId,
  };
}

export function commandPreview(command: string): string {
  const normalized = command.replace(/\s+/g, " ").trim();
  return normalized.length > 120 ? `${normalized.slice(0, 117)}...` : normalized;
}

function requestClientKind(req: Request): "chatgpt" | "claude" | "unknown" {
  const text = [req.header("user-agent"), req.header("origin"), req.header("referer")]
    .filter((value): value is string => Boolean(value))
    .join(" ")
    .toLowerCase();
  if (text.includes("claude") || text.includes("anthropic")) return "claude";
  if (text.includes("chatgpt") || text.includes("openai")) return "chatgpt";
  return "unknown";
}

function conversationIdFields(req: Request): { conversationIdHeader?: string; conversationIdHash?: string } {
  for (const header of CONVERSATION_ID_HEADER_CANDIDATES) {
    const value = firstHeaderValue(req.header(header));
    if (value) return { conversationIdHeader: header, conversationIdHash: hashIdentifier(value) };
  }
  return {};
}

function hashIdentifier(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

function buildAutoThreadId(input: {
  conversationIdHash?: string;
  sessionIdPrefix?: string;
  workspaceId?: string;
  requestIdPrefix?: string;
}): string {
  if (input.conversationIdHash) return `conversation:${input.conversationIdHash}`;
  if (input.sessionIdPrefix) return `mcp-session:${input.sessionIdPrefix}`;
  if (input.workspaceId) return `workspace:${input.workspaceId}`;
  return `request:${input.requestIdPrefix ?? "unknown"}`;
}

function writeFileLog(config: LoggingConfig, entry: LogFields): void {
  if (!config.file || !config.filePath || failedFilePaths.has(config.filePath)) return;

  try {
    const stream = fileStreamFor(config.filePath);
    stream.write(`${JSON.stringify(entry)}\n`);
  } catch (error) {
    failedFilePaths.add(config.filePath);
    process.stderr.write(
      `[devspace] failed to write log file ${JSON.stringify(config.filePath)}: ${error instanceof Error ? error.message : String(error)}\n`,
    );
  }
}

function fileStreamFor(filePath: string): WriteStream {
  const existing = fileStreams.get(filePath);
  if (existing) return existing;

  mkdirSync(dirname(filePath), { recursive: true });
  const stream = createWriteStream(filePath, { flags: "a", encoding: "utf8" });
  stream.on("error", (error) => {
    failedFilePaths.add(filePath);
    process.stderr.write(`[devspace] log file stream error ${JSON.stringify(filePath)}: ${error.message}\n`);
  });
  fileStreams.set(filePath, stream);
  return stream;
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
