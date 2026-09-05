import {
  monitorLogStream,
  type MonitorLogKind,
  type MonitorLogPublishInput,
  type MonitorLogStatus,
} from "./monitor-log-stream.js";
import {
  compactClientKind,
  workspaceIdDisplayToken,
} from "./workbridge-logging.js";
import type { LogLevel } from "./logger.js";
import {
  currentMonitorOperationDetails,
  currentMonitorOperationId,
} from "./monitor-operation-context.js";

type LogFields = Record<string, unknown>;

const DETAIL_KEYS = [
  "requestId",
  "method",
  "path",
  "status",
  "classification",
  "protocolEra",
  "protocolVersion",
  "rpcMethod",
  "mcpMethodHeader",
  "mcpNameHeader",
  "clientName",
  "clientVersion",
  "clientCapabilitiesPresent",
  "signals",
  "outcome",
  "terminalOutcome",
  "requestAborted",
  "responseHeadersSent",
  "responseFinished",
  "responseClosed",
  "responseDestroyed",
  "sessionIdPresent",
  "sessionIdPrefix",
  "contentLength",
  "ip",
  "userAgent",
  "workspaceId",
  "workspaceLabel",
  "tool",
  "operationId",
  "success",
  "executed",
  "running",
  "durationMs",
  "fileCount",
  "affectedFiles",
  "additions",
  "removals",
  "exitCode",
  "signal",
  "sessionId",
  "commandPreview",
  "commandLength",
  "workingDirectory",
  "tty",
  "intent",
  "yieldTimeMs",
  "maxOutputTokens",
  "dryRun",
  "truncated",
  "outputTruncated",
  "timedOut",
  "resultCharacters",
  "error",
  "reason",
  "action",
  "preset",
  "executionPolicy",
  "active",
  "activeRequests",
  "initializedOnly",
  "handshakeOnly",
  "discoveryOnly",
  "operational",
  "toolCallSessions",
  "oneShotCleanupCandidates",
  "reusedToolCallSessions",
  "maxToolCallsPerSession",
  "rssBytes",
  "heapUsedBytes",
  "threshold",
] as const;

export function publishWorkbridgeMonitorLog(
  level: Exclude<LogLevel, "silent">,
  event: string,
  fields: LogFields,
  entry: LogFields,
): void {
  try {
    monitorLogStream.publish(createMonitorLogView(level, event, fields, entry));
  } catch {
    // Monitor rendering must never interfere with normal Workbridge logging.
  }
}

export function createMonitorLogView(
  level: Exclude<LogLevel, "silent">,
  event: string,
  fields: LogFields,
  entry: LogFields,
): MonitorLogPublishInput {
  const kind = monitorLogKind(event, fields);
  const status = monitorLogStatus(level, event, fields);
  const workspaceId = stringField(fields.workspaceId);
  const tool = stringField(fields.tool);
  const operationId = stringField(fields.operationId) ?? currentMonitorOperationId();
  const details = monitorDetails(fields, operationId);
  if (isRoutineSuccessfulMcpHttp(level, event, fields)) details.routineMcpHttp = true;
  return {
    ts: String(entry.ts),
    level,
    event,
    kind,
    status,
    error: status === "error" || status === "warning",
    workspaceId,
    workspace: monitorWorkspace(kind, fields, workspaceId),
    tool,
    operationId,
    operation: tool ?? event,
    durationMs: numberField(fields.durationMs),
    summary: monitorSummary(kind, event, fields),
    details,
  };
}

function isRoutineSuccessfulMcpHttp(
  level: Exclude<LogLevel, "silent">,
  event: string,
  fields: LogFields,
): boolean {
  const status = numberField(fields.status);
  return level === "info"
    && event === "http_request"
    && stringField(fields.method) === "POST"
    && stringField(fields.path) === "/mcp"
    && status !== undefined
    && status >= 200
    && status < 300
    && fields.requestAborted !== true;
}

function monitorLogKind(event: string, fields: LogFields): MonitorLogKind {
  if (event === "http_request") return "http";
  if (event.startsWith("mcp_session_") || event === "mcp_modern_probe_detected") return "session";
  const tool = stringField(fields.tool);
  if (tool === "read" || tool === "grep" || tool === "glob" || tool === "ls") return "read";
  if (tool === "exec_command" || tool === "bash" || tool === "write_stdin" || tool === "run_workspace_action") return "run";
  if (tool === "edit" || tool === "write" || tool === "apply_patch" || tool === "download_artifact") return "change";
  return "other";
}

function monitorLogStatus(
  level: Exclude<LogLevel, "silent">,
  event: string,
  fields: LogFields,
): MonitorLogStatus {
  if (fields.executed === false) return "skipped";
  const httpStatus = numberField(fields.status);
  const expectedOAuthExchange = event === "http_request"
    && (
      (httpStatus === 401
        && stringField(fields.classification) === "auth"
        && stringField(fields.method) === "POST"
        && stringField(fields.path) === "/mcp")
      || (httpStatus === 404 && stringField(fields.classification) === "probe")
    );
  if (expectedOAuthExchange) return "info";
  if (
    level === "error"
    || fields.success === false
    || (httpStatus !== undefined && httpStatus >= 400)
  ) return "error";
  if (level === "warn" || event === "mcp_session_pressure") return "warning";
  if (fields.running === true || stringField(fields.status)?.toLowerCase() === "running") return "running";
  if (
    fields.success === true
    || event === "http_request"
    || event === "mcp_session_metrics"
    || event === "mcp_session_metrics_startup"
  ) return "success";
  return "info";
}

function monitorWorkspace(
  kind: MonitorLogKind,
  fields: LogFields,
  workspaceId: string | undefined,
): string | undefined {
  const label = stringField(fields.workspaceLabel);
  if (label) return label;
  if (workspaceId) return workspaceIdDisplayToken(workspaceId);
  if (kind === "session") return "mcp";
  if (kind === "http") return stringField(fields.ip);
  return undefined;
}

function monitorSummary(kind: MonitorLogKind, event: string, fields: LogFields): string {
  if (event === "mcp_modern_probe_detected") return modernMcpSummary(fields);
  if (kind === "http") return httpSummary(fields);
  if (kind === "session") return sessionSummary(event, fields);
  const tool = stringField(fields.tool);
  if (tool === "run_workspace_action") {
    const action = stringField(fields.action) ?? "workspace action";
    const preset = stringField(fields.preset);
    const command = commandSummary(fields);
    return compactText([preset ? `${action} / ${preset}` : action, command].filter(Boolean).join(" · "));
  }
  if (tool === "exec_command" || tool === "bash") {
    return commandSummary(fields) ?? "Command details are hidden";
  }
  if (tool === "write_stdin") {
    const sessionId = stringField(fields.sessionId);
    return sessionId ? `Process ${sessionId}` : "Process input / polling";
  }
  if (tool === "apply_patch" || tool === "edit" || tool === "write") {
    return changeSummary(fields);
  }
  if (tool === "read" || tool === "grep" || tool === "glob" || tool === "ls" || tool === "download_artifact") {
    return compactText(stringField(fields.path) ?? tool);
  }
  const reason = errorSummary(fields.error);
  return compactText(reason ?? stringField(fields.path) ?? event);
}

function httpSummary(fields: LogFields): string {
  const method = stringField(fields.method) ?? "?";
  const path = stringField(fields.path) ?? "unknown";
  const status = numberField(fields.status);
  const client = compactClientKind(fields.userAgent);
  if (
    method === "POST"
    && path === "/mcp"
    && status === 401
    && stringField(fields.classification) === "auth"
  ) return compactText(["OAuth challenge", `${method} ${path}`, `code ${status}`, client === "unknown" ? undefined : client].filter(Boolean).join(" · "));
  if (status === 404 && stringField(fields.classification) === "probe") {
    return compactText(["OAuth discovery probe", `${method} ${path}`, `code ${status}`, client === "unknown" ? undefined : client].filter(Boolean).join(" · "));
  }
  return compactText([
    `${method} ${path}`,
    status === undefined ? undefined : `code ${status}`,
    client === "unknown" ? undefined : client,
  ].filter(Boolean).join(" · "));
}

function modernMcpSummary(fields: LogFields): string {
  const method = stringField(fields.rpcMethod) ?? stringField(fields.mcpMethodHeader);
  return compactText([
    "Modern MCP",
    method,
    stringField(fields.mcpNameHeader),
    stringField(fields.protocolVersion),
  ].filter(Boolean).join(" · "));
}

function sessionSummary(event: string, fields: LogFields): string {
  const active = numberField(fields.active) ?? 0;
  const requests = numberField(fields.activeRequests) ?? 0;
  const toolSessions = numberField(fields.toolCallSessions) ?? 0;
  const oneShot = numberField(fields.oneShotCleanupCandidates) ?? 0;
  const prefix = event === "mcp_session_pressure" ? "Session pressure" : `Active ${active}`;
  return `${prefix} · Requests ${requests} · Tool sessions ${toolSessions} · One-shot ${oneShot}`;
}

function changeSummary(fields: LogFields): string {
  const path = stringField(fields.path);
  const files = numberField(fields.fileCount) ?? numberField(fields.affectedFiles);
  const additions = numberField(fields.additions);
  const removals = numberField(fields.removals);
  const parts = [
    path,
    files === undefined ? undefined : `${files} file${files === 1 ? "" : "s"}`,
    additions === undefined ? undefined : `+${additions}`,
    removals === undefined ? undefined : `-${removals}`,
  ].filter(Boolean);
  return compactText(parts.join(" · ") || "Workspace change");
}

function commandSummary(fields: LogFields): string | undefined {
  const command = stringField(fields.commandPreview);
  return command ? compactText(command) : undefined;
}

function monitorDetails(
  fields: LogFields,
  operationId: string | undefined,
): Record<string, unknown> {
  const details: Record<string, unknown> = {};
  for (const key of DETAIL_KEYS) {
    const value = safeDetailValue(fields[key], 0);
    if (value !== undefined) details[key] = value;
  }
  if (operationId && operationId === currentMonitorOperationId()) {
    for (const [key, value] of Object.entries(currentMonitorOperationDetails())) {
      if (key === "commandDisplay") continue;
      const safe = safeDetailValue(value, 0, key);
      if (safe !== undefined) details[key] = safe;
    }
  }
  return details;
}

function safeDetailValue(value: unknown, depth: number, key?: string): unknown {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") {
    const maximum = key === "commandDisplay" ? 32 * 1024 : 2_000;
    return value.length > maximum ? `${value.slice(0, maximum - 3)}...` : value;
  }
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (value instanceof Error) return value.message;
  if (depth >= 2) return String(value);
  if (Array.isArray(value)) {
    return value.slice(0, 20).map((item) => safeDetailValue(item, depth + 1));
  }
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .slice(0, 20)
        .map(([key, item]) => [key, safeDetailValue(item, depth + 1)]),
    );
  }
  return String(value);
}

function compactText(value: string, maxLength = 180): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) return "—";
  return normalized.length <= maxLength ? normalized : `${normalized.slice(0, maxLength - 3)}...`;
}

function errorSummary(value: unknown): string | undefined {
  if (value instanceof Error) return value.message;
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
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
