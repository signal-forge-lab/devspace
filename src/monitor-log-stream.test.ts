import assert from "node:assert/strict";
import { MonitorLogStream } from "./monitor-log-stream.js";

const stream = new MonitorLogStream(2);
const received: number[] = [];
const unsubscribe = stream.subscribe((entry) => received.push(entry.sequence));

stream.publish({
  ts: "2026-07-25T00:00:00.000Z",
  level: "info",
  event: "tool_call",
  kind: "read",
  error: false,
  line: "read one",
  workspaceId: "ws_one",
  tool: "read",
  details: { path: "one" },
});
stream.publish({
  ts: "2026-07-25T00:00:01.000Z",
  level: "warn",
  event: "warning",
  kind: "other",
  error: true,
  line: "warning two",
  details: { warning: true },
});
stream.publish({
  ts: "2026-07-25T00:00:02.000Z",
  level: "info",
  event: "http_request",
  kind: "http",
  error: false,
  line: "http three",
  details: { status: 200 },
});

unsubscribe();
assert.deepEqual(received, [1, 2, 3]);
assert.deepEqual(stream.snapshot().logs.map((entry) => entry.sequence), [2, 3]);
assert.deepEqual(stream.snapshot(2).logs.map((entry) => entry.sequence), [3]);
assert.equal(stream.snapshot().latestSequence, 3);
assert.equal(stream.snapshot().logs[0]?.error, true);
assert.throws(() => new MonitorLogStream(0), /positive integer/);
