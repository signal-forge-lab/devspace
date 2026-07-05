#!/usr/bin/env node

import fs from "node:fs";

const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const prefix = `--${name}=`;
  const inline = args.find((value) => value.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = args.indexOf(`--${name}`);
  return index >= 0 && index + 1 < args.length ? args[index + 1] : fallback;
};
const flag = (name) => args.includes(`--${name}`);

if (flag("help") || flag("h")) {
  console.log(`Workbridge automatic session report\n\nGroups efficiency ledger events by workspace/autoThread and estimates session duration and rough work size.\n\nUsage:\n  node scripts/analyze-session-reviews.mjs\n  node scripts/analyze-session-reviews.mjs --gap-minutes 45\n  node scripts/analyze-session-reviews.mjs --json`);
  process.exit(0);
}

const ledgerPath = arg("path", ".devspace/efficiency/events.jsonl");
const gapMinutes = Number(arg("gap-minutes", "30"));
const limitRaw = arg("limit", undefined);
const limit = limitRaw === undefined ? undefined : Number(limitRaw);
if (!Number.isFinite(gapMinutes) || gapMinutes <= 0) throw new Error("--gap-minutes must be positive");
if (limitRaw !== undefined && (!Number.isFinite(limit) || limit <= 0)) throw new Error("--limit must be positive");

const readTools = new Set(["open_workspace", "read", "grep", "glob", "ls", "workspace_snapshot", "read_index_ranges", "grep_context", "file_outline", "devspace_router", "workbridge_router", "devspace_verify", "workbridge_verify"]);
const writeTools = new Set(["write", "edit", "apply_patch", "apply_unified_patch", "apply_structured_edit", "edit_by_line_range", "git_commit_files"]);

function loadEvents(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean).flatMap((line, index) => {
    try {
      const event = JSON.parse(line);
      const ts = new Date(event.ts);
      return Number.isNaN(ts.getTime()) ? [] : [{ ...event, _ts: ts, _line: index + 1 }];
    } catch {
      return [];
    }
  });
}

function sessionKey(event) {
  return event.autoThreadId || (event.workspaceId ? `workspace:${event.workspaceId}` : "workspace:unknown");
}
function summarize(events, index) {
  const sorted = [...events].sort((a, b) => a._ts - b._ts);
  const startedAt = sorted[0]._ts;
  const endedAt = sorted.at(-1)._ts;
  const elapsedMinutes = Math.max(0, Math.round((endedAt - startedAt) / 60000));
  const activeToolMinutes = sorted.reduce((sum, event) => sum + Math.max(0, Number(event.durationMs || 0)) / 60000, 0);
  const toolCallCount = sorted.length;
  const failedToolCalls = sorted.filter((event) => event.success === false).length;
  const hostBlocks = sorted.filter((event) => String(event.error || "").toLowerCase().includes("block")).length;
  const readLikeCalls = sorted.filter((event) => readTools.has(event.tool)).length;
  const writeLikeCalls = sorted.filter((event) => writeTools.has(event.tool)).length;
  const processCalls = sorted.filter((event) => event.tool === "exec_command" || event.tool === "bash").length;
  const commandLengthTotal = sorted.reduce((sum, event) => sum + Math.max(0, Number(event.commandLength || 0)), 0);
  const resultCharactersTotal = sorted.reduce((sum, event) => sum + Math.max(0, Number(event.resultCharacters || 0)), 0);
  const pathsTouched = new Set(sorted.map((event) => event.path).filter(Boolean));
  const additions = sorted.reduce((sum, event) => sum + Math.max(0, Number(event.additions || 0)), 0);
  const removals = sorted.reduce((sum, event) => sum + Math.max(0, Number(event.removals || 0)), 0);
  const tools = [...new Set(sorted.map((event) => event.tool).filter(Boolean))].sort();
  const workspaceIds = [...new Set(sorted.map((event) => event.workspaceId).filter(Boolean))].sort();
  const activityScore = toolCallCount + writeLikeCalls * 2 + processCalls + failedToolCalls * 2 + hostBlocks * 2 + Math.min(20, Math.floor(commandLengthTotal / 500)) + Math.min(20, Math.floor(resultCharactersTotal / 2000)) + Math.min(20, Math.floor((additions + removals) / 25)) + Math.min(10, pathsTouched.size * 2) + Math.min(20, Math.floor(elapsedMinutes / 20));
  let workSize = "S";
  if (activityScore >= 55 || elapsedMinutes >= 150) workSize = "XL";
  else if (activityScore >= 30 || elapsedMinutes >= 60) workSize = "L";
  else if (activityScore >= 12 || elapsedMinutes >= 20) workSize = "M";
  const result = failedToolCalls === toolCallCount && toolCallCount > 0 ? "failed" : hostBlocks > 0 ? "blocked_or_partial" : "done_or_partial";
  let efficiency = "normal";
  if (failedToolCalls >= 3 || hostBlocks >= 2 || (workSize === "S" && elapsedMinutes > 30) || (workSize === "M" && elapsedMinutes > 90)) efficiency = "bad";
  else if (failedToolCalls === 0 && hostBlocks === 0 && ((workSize === "S" && elapsedMinutes <= 15) || (workSize === "M" && elapsedMinutes <= 45) || (workSize === "L" && elapsedMinutes <= 120))) efficiency = "good";
  const mainDelayReason = hostBlocks > 0 ? "host_block" : failedToolCalls > 0 ? "tool_error" : elapsedMinutes > 0 && activeToolMinutes < elapsedMinutes * 0.05 ? "idle_or_human_review" : "none";
  return { sessionIndex: index, sessionKey: sessionKey(sorted[0]), workspaceIds, startedAt: startedAt.toISOString(), endedAt: endedAt.toISOString(), elapsedMinutes, activeToolMinutes: Math.round(activeToolMinutes * 10) / 10, workSize, result, efficiency, mainDelayReason, activityScore, toolCallCount, readLikeCalls, writeLikeCalls, processCalls, failedToolCalls, hostBlocks, distinctToolCount: tools.length, tools, commandLengthTotal, resultCharactersTotal, pathsTouched: pathsTouched.size, additions, removals };
}
function group(events, gapMs) {
  const byKey = new Map();
  for (const event of events) {
    const key = sessionKey(event);
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(event);
  }
  const raw = [];
  for (const eventsForKey of byKey.values()) {
    const sorted = eventsForKey.sort((a, b) => a._ts - b._ts);
    let current = [];
    for (const event of sorted) {
      const previous = current.at(-1);
      if (previous && event._ts - previous._ts > gapMs) {
        raw.push(current);
        current = [];
      }
      current.push(event);
    }
    if (current.length > 0) raw.push(current);
  }
  return raw.sort((a, b) => a[0]._ts - b[0]._ts).map((session, index) => summarize(session, index + 1));
}

const events = loadEvents(ledgerPath);
const selected = limit ? events.slice(-limit) : events;
const sessions = group(selected, gapMinutes * 60000);
const totals = {
  sessions: sessions.length,
  elapsedMinutes: sessions.reduce((sum, session) => sum + session.elapsedMinutes, 0),
  toolCallCount: sessions.reduce((sum, session) => sum + session.toolCallCount, 0),
  readLikeCalls: sessions.reduce((sum, session) => sum + session.readLikeCalls, 0),
  writeLikeCalls: sessions.reduce((sum, session) => sum + session.writeLikeCalls, 0),
  processCalls: sessions.reduce((sum, session) => sum + session.processCalls, 0),
  failedToolCalls: sessions.reduce((sum, session) => sum + session.failedToolCalls, 0),
};
const report = { source: ledgerPath, gapMinutes, eventCount: selected.length, totals, sessions };
if (flag("json")) {
  console.log(JSON.stringify(report, null, 2));
  process.exit(0);
}

const countBy = (field) => {
  const counts = new Map();
  for (const session of sessions) counts.set(session[field], (counts.get(session[field]) || 0) + 1);
  return [...counts.entries()].map(([key, value]) => `- ${key}: ${value}`).join("\n") || "- none";
};
console.log("Workbridge Automatic Session Report");
console.log("===================================\n");
console.log(`Source: ${ledgerPath}`);
console.log(`Events: ${selected.length}`);
console.log(`Idle gap: ${gapMinutes} min`);
console.log(`Sessions: ${totals.sessions}`);
console.log(`Total elapsed: ${totals.elapsedMinutes} min`);
console.log(`Tool calls: ${totals.toolCallCount}`);
console.log(`Read-like calls: ${totals.readLikeCalls}`);
console.log(`Write-like calls: ${totals.writeLikeCalls}`);
console.log(`Process calls: ${totals.processCalls}`);
console.log(`Failed calls: ${totals.failedToolCalls}\n`);
console.log("Work size:");
console.log(countBy("workSize"));
console.log("\nEfficiency:");
console.log(countBy("efficiency"));
console.log("\nSessions:");
for (const session of sessions.slice(-12)) {
  console.log(`- #${session.sessionIndex} ${session.workSize}/${session.efficiency} ${session.elapsedMinutes}min calls=${session.toolCallCount} read=${session.readLikeCalls} write=${session.writeLikeCalls} process=${session.processCalls} failed=${session.failedToolCalls} delay=${session.mainDelayReason}`);
  console.log(`  workspace=${session.workspaceIds.join(",") || "unknown"}`);
  console.log(`  ${session.startedAt} -> ${session.endedAt}`);
}
if (sessions.length > 12) console.log(`... ${sessions.length - 12} earlier session(s) omitted`);
