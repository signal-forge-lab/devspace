import { randomUUID } from "node:crypto";

export const TOOL_TRACE_START_TOOL_NAME = "tool_trace_start";
export const TOOL_TRACE_END_TOOL_NAME = "tool_trace_end";

export interface ToolTraceStartInput {
  workspaceId?: string;
  label?: string;
  userIntent?: string;
}

export interface ToolTraceEndInput {
  traceId?: string;
  workspaceId?: string;
  outcome?: "completed" | "partial" | "failed";
  note?: string;
}

export interface TraceableToolFields {
  tool: string;
  workspaceId?: string;
  path?: string;
  workingDirectory?: string;
  command?: string;
  operation?: string;
  eventCategory?: string;
  eventTool?: string;
  success: boolean;
  error?: string;
}

export interface ToolTraceSummary extends Record<string, unknown> {
  traceId: string;
  workspaceId?: string;
  label?: string;
  userIntent?: string;
  startedAt: string;
  endedAt?: string;
  durationMs?: number;
  active: boolean;
  outcome?: "completed" | "partial" | "failed";
  note?: string;
  totalToolCalls: number;
  successfulToolCalls: number;
  failedToolCalls: number;
  retries: number;
  retriesAfterFailure: number;
  eventReports: number;
  toolCounts: Record<string, number>;
  operationCounts: Record<string, number>;
  eventCategoryCounts: Record<string, number>;
  commandShapeCounts?: Record<string, number>;
  commandShapesHidden: boolean;
  result: string;
}

interface ToolTraceState {
  traceId: string;
  workspaceId?: string;
  label?: string;
  userIntent?: string;
  startedAt: number;
  startedAtIso: string;
  endedAt?: number;
  endedAtIso?: string;
  outcome?: "completed" | "partial" | "failed";
  note?: string;
  active: boolean;
  totalToolCalls: number;
  successfulToolCalls: number;
  failedToolCalls: number;
  retries: number;
  retriesAfterFailure: number;
  eventReports: number;
  toolCounts: Map<string, number>;
  operationCounts: Map<string, number>;
  eventCategoryCounts: Map<string, number>;
  commandShapeCounts: Map<string, number>;
  commandShapesHidden: boolean;
  signatures: Map<string, { count: number; lastSuccess: boolean }>;
}

export interface ToolTraceRecordOptions {
  includeCommandShapes?: boolean;
}

export interface ToolTraceManager {
  start(input: ToolTraceStartInput): ToolTraceSummary;
  end(input: ToolTraceEndInput): ToolTraceSummary;
  current(workspaceId?: string): ToolTraceSummary | undefined;
  recordToolCall(
    fields: TraceableToolFields,
    options?: ToolTraceRecordOptions,
  ): { traceId: string; traceSequence: number } | undefined;
  recordToolEvent(input: {
    workspaceId?: string;
    eventTool: string;
    operation: string;
    category: string;
    commandShape?: string;
  }): { traceId: string; traceSequence: number } | undefined;
}

export function createToolTraceManager(now: () => number = Date.now): ToolTraceManager {
  const traces = new Map<string, ToolTraceState>();
  const activeByWorkspace = new Map<string, string>();
  let activeGlobalTraceId: string | undefined;

  function findActiveTrace(workspaceId?: string): ToolTraceState | undefined {
    const traceId = workspaceId ? activeByWorkspace.get(workspaceId) : activeGlobalTraceId;
    if (traceId) {
      const trace = traces.get(traceId);
      if (trace?.active) return trace;
    }
    if (workspaceId && activeGlobalTraceId) {
      const trace = traces.get(activeGlobalTraceId);
      if (trace?.active) return trace;
    }
    return undefined;
  }

  function start(input: ToolTraceStartInput): ToolTraceSummary {
    if (input.workspaceId) {
      const previous = findActiveTrace(input.workspaceId);
      if (previous) previous.active = false;
    } else if (activeGlobalTraceId) {
      const previous = traces.get(activeGlobalTraceId);
      if (previous) previous.active = false;
    }

    const startedAt = now();
    const trace: ToolTraceState = {
      traceId: buildTraceId(startedAt),
      workspaceId: input.workspaceId,
      label: input.label,
      userIntent: input.userIntent,
      startedAt,
      startedAtIso: new Date(startedAt).toISOString(),
      active: true,
      totalToolCalls: 0,
      successfulToolCalls: 0,
      failedToolCalls: 0,
      retries: 0,
      retriesAfterFailure: 0,
      eventReports: 0,
      toolCounts: new Map(),
      operationCounts: new Map(),
      eventCategoryCounts: new Map(),
      commandShapeCounts: new Map(),
      commandShapesHidden: true,
      signatures: new Map(),
    };
    traces.set(trace.traceId, trace);
    if (input.workspaceId) activeByWorkspace.set(input.workspaceId, trace.traceId);
    else activeGlobalTraceId = trace.traceId;
    return summarize(trace);
  }

  function end(input: ToolTraceEndInput): ToolTraceSummary {
    const trace = input.traceId
      ? traces.get(input.traceId)
      : findActiveTrace(input.workspaceId);
    if (!trace) throw new Error("No active tool trace found.");
    trace.active = false;
    trace.endedAt = now();
    trace.endedAtIso = new Date(trace.endedAt).toISOString();
    trace.outcome = input.outcome ?? "completed";
    trace.note = input.note;
    if (trace.workspaceId && activeByWorkspace.get(trace.workspaceId) === trace.traceId) {
      activeByWorkspace.delete(trace.workspaceId);
    }
    if (activeGlobalTraceId === trace.traceId) activeGlobalTraceId = undefined;
    return summarize(trace);
  }

  function current(workspaceId?: string): ToolTraceSummary | undefined {
    const trace = findActiveTrace(workspaceId);
    return trace ? summarize(trace) : undefined;
  }

  function recordToolCall(
    fields: TraceableToolFields,
    options: ToolTraceRecordOptions = {},
  ): { traceId: string; traceSequence: number } | undefined {
    if ([TOOL_TRACE_START_TOOL_NAME, TOOL_TRACE_END_TOOL_NAME].includes(fields.tool)) {
      return undefined;
    }
    const trace = findActiveTrace(fields.workspaceId);
    if (!trace) return undefined;
    const includeCommandShapes = options.includeCommandShapes ?? false;
    if (includeCommandShapes) trace.commandShapesHidden = false;

    trace.totalToolCalls += 1;
    if (fields.success) trace.successfulToolCalls += 1;
    else trace.failedToolCalls += 1;

    increment(trace.toolCounts, fields.tool);
    if (fields.operation) increment(trace.operationCounts, fields.operation);
    if (fields.eventCategory) increment(trace.eventCategoryCounts, fields.eventCategory);

    const commandShape = includeCommandShapes ? safeCommandShape(fields.command) : undefined;
    if (commandShape) increment(trace.commandShapeCounts, commandShape);

    const signature = buildSignature(fields, commandShape);
    const previous = trace.signatures.get(signature);
    if (previous) {
      trace.retries += 1;
      if (!previous.lastSuccess) trace.retriesAfterFailure += 1;
      previous.count += 1;
      previous.lastSuccess = fields.success;
    } else {
      trace.signatures.set(signature, { count: 1, lastSuccess: fields.success });
    }

    return { traceId: trace.traceId, traceSequence: trace.totalToolCalls };
  }

  function recordToolEvent(input: {
    workspaceId?: string;
    eventTool: string;
    operation: string;
    category: string;
    commandShape?: string;
  }): { traceId: string; traceSequence: number } | undefined {
    const trace = findActiveTrace(input.workspaceId);
    if (!trace) return undefined;
    trace.eventReports += 1;
    increment(trace.eventCategoryCounts, input.category);
    increment(trace.toolCounts, `event:${input.eventTool}`);
    increment(trace.operationCounts, input.operation);
    if (input.commandShape) {
      trace.commandShapesHidden = false;
      increment(trace.commandShapeCounts, input.commandShape);
    }
    return { traceId: trace.traceId, traceSequence: trace.totalToolCalls };
  }

  return { start, end, current, recordToolCall, recordToolEvent };
}

function buildTraceId(nowMs: number): string {
  const timestamp = new Date(nowMs).toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
  return `trace_${timestamp}_${randomUUID().slice(0, 8)}`;
}

function increment(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}

function toObject(map: Map<string, number>): Record<string, number> {
  return Object.fromEntries([...map.entries()].sort(([a], [b]) => a.localeCompare(b)));
}

function safeCommandShape(command: string | undefined): string | undefined {
  if (!command) return undefined;
  const normalized = command.replace(/\s+/g, " ").trim();
  if (!normalized) return undefined;
  return normalized.length > 120 ? `${normalized.slice(0, 117)}...` : normalized;
}

function buildSignature(fields: TraceableToolFields, commandShape: string | undefined): string {
  return [
    fields.tool,
    fields.operation ?? "",
    fields.path ?? "",
    fields.workingDirectory ?? "",
    fields.eventCategory ?? "",
    fields.eventTool ?? "",
    commandShape ?? "",
  ].join("|");
}

function summarize(trace: ToolTraceState): ToolTraceSummary {
  const durationMs = (trace.endedAt ?? Date.now()) - trace.startedAt;
  const summary: ToolTraceSummary = {
    traceId: trace.traceId,
    workspaceId: trace.workspaceId,
    label: trace.label,
    userIntent: trace.userIntent,
    startedAt: trace.startedAtIso,
    endedAt: trace.endedAtIso,
    durationMs,
    active: trace.active,
    outcome: trace.outcome,
    note: trace.note,
    totalToolCalls: trace.totalToolCalls,
    successfulToolCalls: trace.successfulToolCalls,
    failedToolCalls: trace.failedToolCalls,
    retries: trace.retries,
    retriesAfterFailure: trace.retriesAfterFailure,
    eventReports: trace.eventReports,
    toolCounts: toObject(trace.toolCounts),
    operationCounts: toObject(trace.operationCounts),
    eventCategoryCounts: toObject(trace.eventCategoryCounts),
    commandShapeCounts: trace.commandShapeCounts.size > 0 ? toObject(trace.commandShapeCounts) : undefined,
    commandShapesHidden: trace.commandShapesHidden,
    result: "",
  };
  summary.result = formatSummary(summary);
  return summary;
}

function formatSummary(summary: ToolTraceSummary): string {
  return [
    `Trace: ${summary.traceId}${summary.active ? " (active)" : ""}`,
    summary.label ? `Label: ${summary.label}` : undefined,
    summary.workspaceId ? `Workspace: ${summary.workspaceId}` : undefined,
    `Tool calls: ${summary.totalToolCalls} (${summary.successfulToolCalls} success, ${summary.failedToolCalls} failed)`,
    `Retries: ${summary.retries} (${summary.retriesAfterFailure} after failure)`,
    `Event reports: ${summary.eventReports}`,
    `Tools: ${JSON.stringify(summary.toolCounts)}`,
    Object.keys(summary.operationCounts).length > 0
      ? `Operations: ${JSON.stringify(summary.operationCounts)}`
      : undefined,
    summary.commandShapeCounts
      ? `Command shapes: ${JSON.stringify(summary.commandShapeCounts)}`
      : summary.commandShapesHidden
        ? "Command shapes: hidden"
        : undefined,
  ].filter(Boolean).join("\n");
}
