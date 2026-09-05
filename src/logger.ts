import type { Request } from "express";
import { publishWorkbridgeMonitorLog } from "./monitor-log-view.js";
import {
  writeWorkbridgeJsonlLog,
} from "./workbridge-logging.js";

export {
  classifyHttpRequest,
  compactClientKind,
  loggedCommandFields,
  sanitizeRequestUrlForLog,
  shouldSuppressSuccessfulMonitorPoll,
  workspaceIdDisplayToken,
} from "./workbridge-logging.js";
export type { HttpRequestClassification } from "./workbridge-logging.js";

export type LogLevel = "silent" | "error" | "warn" | "info" | "debug";
export type LogFormat = "json" | "pretty";

export interface LoggingConfig {
  level: LogLevel;
  format: LogFormat;
  file: boolean;
  filePath?: string;
  fileMaxBytes?: number;
  fileMaxFiles: number;
  requests: boolean;
  assets: boolean;
  toolCalls: boolean;
  shellCommands: boolean;
  trustProxy: boolean;
}

type LogFields = Record<string, unknown>;

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

export function errorLogFields(error: unknown): LogFields {
  if (!(error instanceof Error)) return { error: String(error) };

  return {
    error: error.message,
    errorName: error.name,
    ...(error.stack ? { errorStack: error.stack } : {}),
    ...(error.cause !== undefined
      ? {
        errorCause: error.cause instanceof Error
          ? {
            name: error.cause.name,
            message: error.cause.message,
            ...(error.cause.stack ? { stack: error.cause.stack } : {}),
          }
          : String(error.cause),
      }
      : {}),
  };
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
  writeWorkbridgeJsonlLog(config, entry);
  publishWorkbridgeMonitorLog(level, event, fields, entry);

  const line = config.format === "pretty" ? formatPretty(entry) : JSON.stringify(entry);
  if (level === "error") {
    console.error(line);
  } else if (level === "warn") {
    console.warn(line);
  } else {
    console.log(line);
  }
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
