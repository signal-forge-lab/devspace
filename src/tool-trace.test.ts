import assert from "node:assert/strict";
import { createToolTraceManager } from "./tool-trace.js";

let now = Date.parse("2026-06-24T00:00:00.000Z");
const traces = createToolTraceManager(() => now);

const started = traces.start({
  workspaceId: "ws-test",
  label: "unit trace",
  userIntent: "verify trace aggregation",
});
assert.equal(started.active, true);
assert.equal(started.totalToolCalls, 0);

const first = traces.recordToolCall({
  tool: "read_many",
  workspaceId: "ws-test",
  operation: "read_many",
  success: true,
});
assert.equal(first?.traceId, started.traceId);
assert.equal(first?.traceSequence, 1);

traces.recordToolCall({
  tool: "bash",
  workspaceId: "ws-test",
  operation: "git_status",
  command: "git status --short",
  success: false,
  error: "filtered",
}, { includeCommandShapes: true });

traces.recordToolCall({
  tool: "bash",
  workspaceId: "ws-test",
  operation: "git_status",
  command: "git status --short",
  success: true,
}, { includeCommandShapes: true });

traces.recordToolEvent({
  workspaceId: "ws-test",
  eventTool: "bash",
  operation: "git_commit",
  category: "host_filter",
  commandShape: "git commit -m <message>",
});

const current = traces.current("ws-test");
assert.equal(current?.totalToolCalls, 3);
assert.equal(current?.failedToolCalls, 1);
assert.equal(current?.retries, 1);
assert.equal(current?.retriesAfterFailure, 1);
assert.equal(current?.eventReports, 1);
assert.equal(current?.toolCounts.bash, 2);
assert.equal(current?.toolCounts["event:bash"], 1);
assert.equal(current?.operationCounts.git_status, 2);
assert.equal(current?.operationCounts.git_commit, 1);
assert.equal(current?.commandShapeCounts?.["git status --short"], 2);
assert.equal(current?.commandShapeCounts?.["git commit -m <message>"], 1);

now += 1000;
const ended = traces.end({ workspaceId: "ws-test", outcome: "completed" });
assert.equal(ended.active, false);
assert.equal(ended.outcome, "completed");
assert.equal(ended.durationMs, 1000);
assert.match(ended.result, /Tool calls: 3/);
assert.equal(traces.current("ws-test"), undefined);

assert.throws(() => traces.end({ workspaceId: "ws-test" }), /No active tool trace/);
