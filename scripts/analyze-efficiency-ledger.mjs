#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const args = process.argv.slice(2);
const pathArg = args.find((arg) => !arg.startsWith("--")) ?? ".devspace/efficiency/events.jsonl";
const json = args.includes("--json");
const sinceArg = valueAfter("--since-hours");
const limitArg = valueAfter("--limit");
const events = readEvents(resolve(pathArg));
const sinceMs = sinceArg ? Date.now() - Number(sinceArg) * 3600_000 : undefined;
const filtered = events.filter((event) => !sinceMs || Date.parse(event.ts) >= sinceMs);
const limited = limitArg && filtered.length > Number(limitArg) ? filtered.slice(-Number(limitArg)) : filtered;
const summary = summarize(limited);
const report = {
  sourcePath: resolve(pathArg),
  generatedAt: new Date().toISOString(),
  sinceHours: sinceArg ? Number(sinceArg) : undefined,
  summary,
  byClientKind: groups(limited, (event) => event.clientKind ?? "unknown"),
  hints: hints(summary),
};
if (json) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(format(report));
}

function valueAfter(name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function readEvents(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split(/\r?\n/).filter(Boolean).flatMap((line) => {
    try { return [JSON.parse(line)]; } catch { return []; }
  });
}

function summarize(events) {
  const tool = events.filter((event) => event.event === "tool_call");
  const out = tool.map(outputChars).filter((value) => value > 0);
  return {
    eventCount: events.length,
    toolCallCount: tool.length,
    failedToolCallCount: tool.filter((event) => event.success === false).length,
    bashCallCount: tool.filter((event) => ["bash", "run_shell", "shell", "exec_command"].includes(event.tool)).length,
    readManyCallCount: tool.filter((event) => event.tool === "read_many").length,
    routerCallCount: tool.filter((event) => event.tool === "devspace_router").length,
    verifyCallCount: tool.filter((event) => event.tool === "devspace_verify").length,
    structuredEditCallCount: tool.filter((event) => ["edit_many", "edit_by_line_range", "apply_structured_edit", "apply_unified_patch", "apply_patch"].includes(event.tool)).length,
    patchCallCount: tool.filter((event) => ["apply_patch", "apply_unified_patch"].includes(event.tool)).length,
    processCommandCallCount: tool.filter((event) => event.tool === "exec_command").length,
    processInteractionCallCount: tool.filter((event) => event.tool === "write_stdin").length,
    gitCallCount: tool.filter((event) => String(event.tool ?? "").startsWith("git_")).length,
    safetyBlockCount: events.filter((event) => event.event === "host_block" || event.category === "host_filter" || event.category === "client_filter").length,
    truncatedOutputCount: tool.filter((event) => event.truncated === true).length,
    oversizedOutputCount: out.filter((value) => value >= 50000).length,
    totalOutputChars: out.reduce((sum, value) => sum + value, 0),
    maxOutputChars: Math.max(0, ...out),
  };
}

function groups(events, keyFor) {
  const map = new Map();
  for (const event of events) {
    const key = keyFor(event);
    const item = map.get(key) ?? { key, toolCallCount: 0, failedToolCallCount: 0, bashCallCount: 0, safetyBlockCount: 0, totalOutputChars: 0, lastSeenAt: event.ts };
    if (event.event === "tool_call") {
      item.toolCallCount += 1;
      if (event.success === false) item.failedToolCallCount += 1;
      if (["bash", "run_shell", "shell", "exec_command"].includes(event.tool)) item.bashCallCount += 1;
      item.totalOutputChars += outputChars(event);
    }
    if (event.event === "host_block" || event.category === "host_filter" || event.category === "client_filter") item.safetyBlockCount += 1;
    if (event.ts > item.lastSeenAt) item.lastSeenAt = event.ts;
    map.set(key, item);
  }
  return Array.from(map.values()).sort((a, b) => b.toolCallCount - a.toolCallCount).slice(0, 10);
}

function outputChars(event) {
  return Number.isFinite(event.resultCharacters) ? event.resultCharacters : Number.isFinite(event.returnedCharacters) ? event.returnedCharacters : Number.isFinite(event.outputChars) ? event.outputChars : 0;
}

function hints(summary) {
  const list = [];
  if (summary.toolCallCount === 0) list.push("No efficiency events were found yet.");
  if (summary.bashCallCount >= 3 && summary.bashCallCount / summary.toolCallCount >= 0.35) list.push("Bash usage is high; prefer fixed or structured Workbridge tools.");
  if (summary.failedToolCallCount >= 2 && summary.failedToolCallCount / summary.toolCallCount >= 0.12) list.push("Tool failure rate is elevated.");
  if (summary.safetyBlockCount > 0) list.push("Host/client filter events were recorded.");
  if (summary.truncatedOutputCount > 0 || summary.oversizedOutputCount > 0) list.push("Large or truncated outputs occurred.");
  return list;
}

function format(report) {
  const s = report.summary;
  return [
    "Workbridge Efficiency Report",
    `Generated: ${report.generatedAt}`,
    `Source: ${report.sourcePath}`,
    report.sinceHours ? `Window: last ${report.sinceHours}h` : "Window: all ledger events",
    "",
    "Summary:",
    `- events: ${s.eventCount}`,
    `- tool calls: ${s.toolCallCount}`,
    `- failures: ${s.failedToolCallCount}`,
    `- bash calls: ${s.bashCallCount}`,
    `- read_many calls: ${s.readManyCallCount}`,
    `- patch calls: ${s.patchCallCount}`,
    `- process commands: ${s.processCommandCallCount}`,
    `- process interactions: ${s.processInteractionCallCount}`,
    `- router calls: ${s.routerCallCount}`,
    `- verify calls: ${s.verifyCallCount}`,
    `- safety blocks: ${s.safetyBlockCount}`,
    `- total output chars: ${s.totalOutputChars}`,
    "",
    "Hints:",
    ...(report.hints.length ? report.hints.map((hint) => `- ${hint}`) : ["- None"]),
  ].join("\n");
}
