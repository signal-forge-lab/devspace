import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { appMetadataFields } from "./app-metadata.js";

export type EfficiencyClientKind = "chatgpt" | "claude" | "unknown";
export type EfficiencyEventKind = "tool_call" | "host_block" | "workflow_event";

export interface EfficiencyEvent extends Record<string, unknown> {
  ts: string;
  event: EfficiencyEventKind;
  clientKind?: EfficiencyClientKind;
  workspaceId?: string;
  autoThreadId?: string;
  conversationIdHash?: string;
  sessionIdPrefix?: string;
  tool?: string;
  operation?: string;
  category?: string;
  success?: boolean;
  durationMs?: number;
  resultCharacters?: number;
  returnedCharacters?: number;
  outputChars?: number;
  maxOutputChars?: number;
  truncated?: boolean;
  error?: string;
}

export interface EfficiencySummary {
  eventCount: number;
  toolCallCount: number;
  failedToolCallCount: number;
  bashCallCount: number;
  readCallCount: number;
  readManyCallCount: number;
  routerCallCount: number;
  verifyCallCount: number;
  structuredEditCallCount: number;
  patchCallCount: number;
  processCommandCallCount: number;
  processInteractionCallCount: number;
  gitCallCount: number;
  safetyBlockCount: number;
  truncatedOutputCount: number;
  oversizedOutputCount: number;
  totalOutputChars: number;
  maxOutputChars: number;
  bashRate: number;
  failureRate: number;
  structuredToolRate: number;
  readBatchingRate: number;
  verifyUsageRate: number;
}

export interface EfficiencyGroupSummary {
  key: string;
  toolCallCount: number;
  failedToolCallCount: number;
  bashCallCount: number;
  safetyBlockCount: number;
  totalOutputChars: number;
  lastSeenAt: string;
}

export interface EfficiencyReport {
  result: string;
  sourcePath: string;
  generatedAt: string;
  sinceHours?: number;
  summary: EfficiencySummary;
  byClientKind: EfficiencyGroupSummary[];
  byWorkspace: EfficiencyGroupSummary[];
  byAutoThread: EfficiencyGroupSummary[];
  hints: string[];
}

export interface AnalyzeEfficiencyOptions {
  path?: string;
  sinceHours?: number;
  limit?: number;
}

const DEFAULT_LEDGER_PATH = ".devspace/efficiency/events.jsonl";

export function defaultEfficiencyLedgerPath(): string {
  return resolve(process.cwd(), process.env.WORKBRIDGE_EFFICIENCY_LEDGER_PATH || process.env.DEVSPACE_EFFICIENCY_LEDGER_PATH || DEFAULT_LEDGER_PATH);
}

export function efficiencyLedgerEnabled(): boolean {
  const value = process.env.WORKBRIDGE_EFFICIENCY_LEDGER ?? process.env.DEVSPACE_EFFICIENCY_LEDGER;
  return !["0", "false", "off", "no"].includes(String(value ?? "1").toLowerCase());
}

export function classifyClientKind(fields: Record<string, unknown> = {}): EfficiencyClientKind {
  const text = [fields.userAgent, fields.origin, fields.referer]
    .filter((value): value is string => typeof value === "string")
    .join(" ")
    .toLowerCase();
  if (text.includes("claude") || text.includes("anthropic")) return "claude";
  if (text.includes("chatgpt") || text.includes("openai")) return "chatgpt";
  return "unknown";
}

export function appendEfficiencyEvent(event: Omit<EfficiencyEvent, "ts"> & { ts?: string }): void {
  if (!efficiencyLedgerEnabled()) return;
  const filePath = defaultEfficiencyLedgerPath();
  const entry: EfficiencyEvent = {
    ts: event.ts ?? new Date().toISOString(),
    ...appMetadataFields(),
    ...event,
  } as EfficiencyEvent;
  try {
    mkdirSync(dirname(filePath), { recursive: true });
    appendFileSync(filePath, `${JSON.stringify(entry)}\n`, "utf8");
  } catch (error) {
    process.stderr.write(`[workbridge] failed to write efficiency ledger: ${error instanceof Error ? error.message : String(error)}\n`);
  }
}

export function analyzeEfficiencyLedger(options: AnalyzeEfficiencyOptions = {}): EfficiencyReport {
  const sourcePath = resolve(options.path ?? defaultEfficiencyLedgerPath());
  const generatedAt = new Date().toISOString();
  const allEvents = readEfficiencyEvents(sourcePath);
  const sinceMs = options.sinceHours ? Date.now() - options.sinceHours * 3600_000 : undefined;
  const filtered = allEvents.filter((event) => {
    if (!sinceMs) return true;
    const ts = Date.parse(event.ts);
    return Number.isFinite(ts) && ts >= sinceMs;
  });
  const events = options.limit && filtered.length > options.limit ? filtered.slice(-options.limit) : filtered;
  const summary = summarizeEfficiency(events);
  const byClientKind = summarizeGroups(events, (event) => event.clientKind ?? "unknown");
  const byWorkspace = summarizeGroups(events, (event) => event.workspaceId ?? "none");
  const byAutoThread = summarizeGroups(events, (event) => event.autoThreadId ?? "none");
  const hints = improvementHints(summary);
  const result = formatEfficiencyReport({ sourcePath, generatedAt, sinceHours: options.sinceHours, summary, byClientKind, byWorkspace, byAutoThread, hints });
  return { result, sourcePath, generatedAt, sinceHours: options.sinceHours, summary, byClientKind, byWorkspace, byAutoThread, hints };
}
export function summarizeEfficiency(events: EfficiencyEvent[]): EfficiencySummary {
  const toolCalls = events.filter((event) => event.event === "tool_call");
  const toolCallCount = toolCalls.length;
  const failedToolCallCount = toolCalls.filter((event) => event.success === false).length;
  const bashCallCount = toolCalls.filter((event) => isBashTool(event.tool)).length;
  const readCallCount = toolCalls.filter((event) => isReadTool(event.tool)).length;
  const readManyCallCount = toolCalls.filter((event) => event.tool === "read_many").length;
  const routerCallCount = toolCalls.filter((event) => event.tool === "workbridge_router").length;
  const verifyCallCount = toolCalls.filter((event) => event.tool === "workbridge_verify").length;
  const structuredEditCallCount = toolCalls.filter((event) => isStructuredEditTool(event.tool)).length;
  const patchCallCount = toolCalls.filter((event) => isPatchTool(event.tool)).length;
  const processCommandCallCount = toolCalls.filter((event) => event.tool === "exec_command" || event.tool === "launch_workspace_task").length;
  const processInteractionCallCount = toolCalls.filter((event) => event.tool === "write_stdin").length;
  const gitCallCount = toolCalls.filter((event) => String(event.tool ?? "").startsWith("git_")).length;
  const safetyBlockCount = events.filter((event) => event.event === "host_block" || event.category === "host_filter" || event.category === "client_filter").length;
  const truncatedOutputCount = toolCalls.filter((event) => event.truncated === true).length;
  const outputValues = toolCalls.map(outputCharsFor).filter((value) => value > 0);
  const totalOutputChars = outputValues.reduce((sum, value) => sum + value, 0);
  const maxOutputChars = Math.max(0, ...outputValues);
  const oversizedOutputCount = outputValues.filter((value) => value >= 50_000).length;
  return {
    eventCount: events.length,
    toolCallCount,
    failedToolCallCount,
    bashCallCount,
    readCallCount,
    readManyCallCount,
    routerCallCount,
    verifyCallCount,
    structuredEditCallCount,
    patchCallCount,
    processCommandCallCount,
    processInteractionCallCount,
    gitCallCount,
    safetyBlockCount,
    truncatedOutputCount,
    oversizedOutputCount,
    totalOutputChars,
    maxOutputChars,
    bashRate: ratio(bashCallCount, toolCallCount),
    failureRate: ratio(failedToolCallCount, toolCallCount),
    structuredToolRate: ratio(structuredEditCallCount + routerCallCount + verifyCallCount + readManyCallCount, toolCallCount),
    readBatchingRate: ratio(readManyCallCount, readCallCount + readManyCallCount),
    verifyUsageRate: ratio(verifyCallCount, toolCallCount),
  };
}

function readEfficiencyEvents(path: string): EfficiencyEvent[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as EfficiencyEvent];
      } catch {
        return [];
      }
    });
}

function summarizeGroups(events: EfficiencyEvent[], keyFor: (event: EfficiencyEvent) => string): EfficiencyGroupSummary[] {
  const groups = new Map<string, EfficiencyGroupSummary>();
  for (const event of events) {
    const key = keyFor(event);
    const group = groups.get(key) ?? { key, toolCallCount: 0, failedToolCallCount: 0, bashCallCount: 0, safetyBlockCount: 0, totalOutputChars: 0, lastSeenAt: event.ts };
    if (event.event === "tool_call") {
      group.toolCallCount += 1;
      if (event.success === false) group.failedToolCallCount += 1;
      if (isBashTool(event.tool)) group.bashCallCount += 1;
      group.totalOutputChars += outputCharsFor(event);
    }
    if (event.event === "host_block" || event.category === "host_filter" || event.category === "client_filter") group.safetyBlockCount += 1;
    if (event.ts > group.lastSeenAt) group.lastSeenAt = event.ts;
    groups.set(key, group);
  }
  return Array.from(groups.values()).sort((a, b) => b.toolCallCount - a.toolCallCount || b.totalOutputChars - a.totalOutputChars).slice(0, 10);
}

function improvementHints(summary: EfficiencySummary): string[] {
  const hints: string[] = [];
  if (summary.toolCallCount === 0) hints.push("No efficiency events were found yet. Restart Workbridge after enabling v1.1.48 and run a few tool calls.");
  if (summary.bashRate >= 0.35 && summary.bashCallCount >= 3) hints.push("Bash usage is high. Prefer workbridge_guide, workbridge_verify, grep_context, file_outline, or structured edit tools where possible.");
  if (summary.failureRate >= 0.12 && summary.failedToolCallCount >= 2) hints.push("Tool failure rate is elevated. Inspect repeated failing tool shapes before retrying.");
  if (summary.safetyBlockCount > 0) hints.push("Host/client filter events were recorded. Avoid repeating the same command shape; choose a safer bounded tool.");
  if (summary.truncatedOutputCount > 0 || summary.oversizedOutputCount > 0) hints.push("Large or truncated outputs occurred. Lower max output limits or narrow inspection before broad reads.");
  if (summary.verifyCallCount === 0 && summary.toolCallCount >= 5) hints.push("No fixed verification tool calls were recorded. Use workbridge_verify profiles for standard checks when available.");
  return hints;
}

export function formatEfficiencyReport(report: Omit<EfficiencyReport, "result">): string {
  const lines = [
    "Workbridge Efficiency Report",
    `Generated: ${report.generatedAt}`,
    `Source: ${report.sourcePath}`,
    report.sinceHours ? `Window: last ${report.sinceHours}h` : "Window: all ledger events",
    "",
    "Summary:",
    `- events: ${report.summary.eventCount}`,
    `- tool calls: ${report.summary.toolCallCount}`,
    `- failures: ${report.summary.failedToolCallCount} (${percent(report.summary.failureRate)})`,
    `- bash calls: ${report.summary.bashCallCount} (${percent(report.summary.bashRate)})`,
    `- structured/tooling calls: ${percent(report.summary.structuredToolRate)}`,
    `- patch calls: ${report.summary.patchCallCount}`,
    `- process commands: ${report.summary.processCommandCallCount}`,
    `- process interactions: ${report.summary.processInteractionCallCount}`,
    `- read batching rate: ${percent(report.summary.readBatchingRate)}`,
    `- verify calls: ${report.summary.verifyCallCount} (${percent(report.summary.verifyUsageRate)})`,
    `- safety blocks: ${report.summary.safetyBlockCount}`,
    `- truncated outputs: ${report.summary.truncatedOutputCount}`,
    `- total output chars: ${report.summary.totalOutputChars}`,
    `- max output chars: ${report.summary.maxOutputChars}`,
  ];
  if (report.byClientKind.length > 0) lines.push("", "By client:", ...report.byClientKind.map(formatGroup));
  if (report.byWorkspace.length > 0) lines.push("", "By workspace:", ...report.byWorkspace.map(formatGroup));
  if (report.hints.length > 0) lines.push("", "Hints:", ...report.hints.map((hint) => `- ${hint}`));
  return lines.join("\n");
}

function formatGroup(group: EfficiencyGroupSummary): string {
  return `- ${group.key}: tools=${group.toolCallCount}, failures=${group.failedToolCallCount}, bash=${group.bashCallCount}, blocks=${group.safetyBlockCount}, output=${group.totalOutputChars}, last=${group.lastSeenAt}`;
}

function outputCharsFor(event: EfficiencyEvent): number {
  return numeric(event.resultCharacters) ?? numeric(event.returnedCharacters) ?? numeric(event.outputChars) ?? 0;
}

function numeric(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function ratio(numerator: number, denominator: number): number {
  return denominator > 0 ? Number((numerator / denominator).toFixed(4)) : 0;
}

function percent(value: number): string {
  return `${Math.round(value * 1000) / 10}%`;
}

function isBashTool(tool: unknown): boolean {
  return tool === "bash" || tool === "run_shell" || tool === "shell" || tool === "exec_command";
}

function isReadTool(tool: unknown): boolean {
  return tool === "read" || tool === "read_file" || tool === "grep" || tool === "grep_files" || tool === "grep_context" || tool === "file_outline" || tool === "read_index_ranges";
}

function isPatchTool(tool: unknown): boolean {
  return tool === "apply_patch" || tool === "apply_unified_patch";
}

function isStructuredEditTool(tool: unknown): boolean {
  return ["edit_many", "edit_by_line_range", "apply_structured_edit", "apply_unified_patch", "apply_patch", "insert_by_anchor", "replace_symbol", "edit_preflight_index"].includes(String(tool ?? ""));
}
