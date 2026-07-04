import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { analyzeEfficiencyLedger, appendEfficiencyEvent, classifyClientKind, summarizeEfficiency } from "./efficiency-ledger.js";

const root = await mkdtemp(join(tmpdir(), "workbridge-efficiency-"));
const ledgerPath = join(root, "events.jsonl");
try {
  assert.equal(classifyClientKind({ userAgent: "Claude-User" }), "claude");
  assert.equal(classifyClientKind({ referer: "https://chatgpt.com/" }), "chatgpt");
  assert.equal(classifyClientKind({ userAgent: "curl" }), "unknown");

  const events = [
    { ts: "2026-01-01T00:00:00.000Z", event: "tool_call" as const, tool: "bash", success: true, resultCharacters: 1200 },
    { ts: "2026-01-01T00:00:01.000Z", event: "tool_call" as const, tool: "read_many", success: true, resultCharacters: 500 },
    { ts: "2026-01-01T00:00:02.000Z", event: "tool_call" as const, tool: "workbridge_verify", success: false, truncated: true, resultCharacters: 60000 },
    { ts: "2026-01-01T00:00:03.000Z", event: "tool_call" as const, tool: "apply_patch", success: true, resultCharacters: 300 },
    { ts: "2026-01-01T00:00:04.000Z", event: "tool_call" as const, tool: "exec_command", success: true, resultCharacters: 700 },
    { ts: "2026-01-01T00:00:05.000Z", event: "tool_call" as const, tool: "write_stdin", success: true, resultCharacters: 50 },
    { ts: "2026-01-01T00:00:06.000Z", event: "host_block" as const, category: "host_filter" },
  ];
  const summary = summarizeEfficiency(events);
  assert.equal(summary.toolCallCount, 6);
  assert.equal(summary.failedToolCallCount, 1);
  assert.equal(summary.bashCallCount, 2);
  assert.equal(summary.readManyCallCount, 1);
  assert.equal(summary.verifyCallCount, 1);
  assert.equal(summary.patchCallCount, 1);
  assert.equal(summary.processCommandCallCount, 1);
  assert.equal(summary.processInteractionCallCount, 1);
  assert.equal(summary.safetyBlockCount, 1);
  assert.equal(summary.truncatedOutputCount, 1);
  assert.equal(summary.oversizedOutputCount, 1);

  await writeFile(ledgerPath, events.map((event) => JSON.stringify(event)).join("\n") + "\n", "utf8");
  const report = analyzeEfficiencyLedger({ path: ledgerPath });
  assert.match(report.result, /Workbridge Efficiency Report/);
  assert.equal(report.summary.toolCallCount, 6);
  assert.ok(report.hints.length > 0);

  process.env.WORKBRIDGE_EFFICIENCY_LEDGER_PATH = join(root, "append.jsonl");
  appendEfficiencyEvent({ event: "tool_call", tool: "git_status", success: true, clientKind: "unknown" });
  const appended = analyzeEfficiencyLedger({ path: process.env.WORKBRIDGE_EFFICIENCY_LEDGER_PATH });
  assert.equal(appended.summary.gitCallCount, 1);
} finally {
  delete process.env.WORKBRIDGE_EFFICIENCY_LEDGER_PATH;
  await rm(root, { recursive: true, force: true });
}
