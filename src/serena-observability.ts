import type { Stream } from "node:stream";
import {
  monitorLogStream,
  type MonitorLogStatus,
  type MonitorLogStream,
} from "./monitor-log-stream.js";
import { sanitizeMonitorText } from "./monitor-operation-context.js";

const SERENA_LOG_LINE = /^(DEBUG|INFO|WARNING|WARN|ERROR|CRITICAL)\s+.+?\s+\[[^\]]+\]\s+(\S+)\s+-\s+(.*)$/;
const MAX_SUMMARY_CHARACTERS = 2_000;

export interface SerenaMonitorLoggingOptions {
  workspaceId: string;
  logs?: MonitorLogStream;
}

export function attachSerenaMonitorLogging(
  stderr: Stream | null,
  options: SerenaMonitorLoggingOptions,
): () => void {
  if (!stderr) return () => undefined;

  const logs = options.logs ?? monitorLogStream;
  let buffer = "";
  const publishLine = (rawLine: string) => {
    const line = rawLine.trim();
    if (!line) return;
    const parsed = parseSerenaLogLine(line);
    if (parsed.level === "debug") return;
    const summary = limitSummary(sanitizeMonitorText(parsed.message));
    if (!summary) return;
    const status = statusForLevel(parsed.level);
    logs.publish({
      ts: new Date().toISOString(),
      level: parsed.level === "warning" ? "warn" : parsed.level,
      event: "serena_log",
      kind: "other",
      status,
      error: status === "warning" || status === "error",
      workspaceId: options.workspaceId,
      operation: "Serena",
      summary,
      details: {
        source: "serena",
        channel: "stderr",
        ...(parsed.logger ? { logger: parsed.logger } : {}),
      },
    });
  };
  const flush = () => {
    if (buffer) publishLine(buffer);
    buffer = "";
  };
  const onData = (chunk: unknown) => {
    buffer += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
    const lines = buffer.split(/\r\n|\n|\r/);
    buffer = lines.pop() ?? "";
    for (const line of lines) publishLine(line);
  };

  stderr.on("data", onData);
  stderr.on("end", flush);
  stderr.on("close", flush);
  return () => {
    flush();
    stderr.off("data", onData);
    stderr.off("end", flush);
    stderr.off("close", flush);
  };
}

function parseSerenaLogLine(line: string): {
  level: "debug" | "info" | "warning" | "error";
  logger?: string;
  message: string;
} {
  const match = SERENA_LOG_LINE.exec(line);
  if (!match) return { level: "info", message: line };
  const rawLevel = match[1] ?? "INFO";
  return {
    level: rawLevel === "DEBUG"
      ? "debug"
      : rawLevel === "WARNING" || rawLevel === "WARN"
        ? "warning"
        : rawLevel === "ERROR" || rawLevel === "CRITICAL"
          ? "error"
          : "info",
    logger: match[2],
    message: match[3] ?? line,
  };
}

function statusForLevel(level: "debug" | "info" | "warning" | "error"): MonitorLogStatus {
  if (level === "error") return "error";
  if (level === "warning") return "warning";
  return "info";
}

function limitSummary(value: string): string {
  return value.length <= MAX_SUMMARY_CHARACTERS
    ? value
    : `${value.slice(0, MAX_SUMMARY_CHARACTERS - 3)}...`;
}
