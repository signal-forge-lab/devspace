import assert from "node:assert/strict";
import { MonitorLogStream } from "./monitor-log-stream.js";

const stream = new MonitorLogStream(2);
const received: number[] = [];
const unsubscribe = stream.subscribe((entry) => received.push(entry.sequence));

const firstEntry = stream.publish({
  ts: "2026-07-25T00:00:00.000Z",
  level: "info",
  event: "tool_call",
  kind: "read",
  status: "success",
  error: false,
  workspaceId: "ws_one",
  workspace: "one",
  tool: "read",
  operationId: "op-one",
  operation: "read",
  durationMs: 3,
  summary: "one",
  details: { path: "one" },
});
stream.publish({
  ts: "2026-07-25T00:00:01.000Z",
  level: "warn",
  event: "warning",
  kind: "other",
  status: "warning",
  error: true,
  operation: "warning",
  summary: "warning two",
  details: { warning: true },
});
stream.publish({
  ts: "2026-07-25T00:00:02.000Z",
  level: "info",
  event: "http_request",
  kind: "http",
  status: "success",
  error: false,
  operation: "http_request",
  summary: "GET /monitor",
  details: { status: 200 },
});

unsubscribe();
assert.deepEqual(received, [1, 2, 3]);
assert.equal(firstEntry.operationId, "op-one");
assert.equal(stream.snapshot().version, 2);
assert.deepEqual(stream.snapshot().logs.map((entry) => entry.sequence), [2, 3]);
assert.deepEqual(stream.snapshot(2).logs.map((entry) => entry.sequence), [3]);
assert.equal(stream.snapshot().latestSequence, 3);
assert.equal(stream.snapshot().logs[0]?.error, true);
assert.throws(() => new MonitorLogStream(0), /positive integer/);
