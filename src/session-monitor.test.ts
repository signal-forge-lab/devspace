import assert from "node:assert/strict";
import {
  classifyToolResult,
  SessionMonitor,
  summarizeToolTarget,
  workspaceLabelFromPath,
} from "./session-monitor.js";

const monitor = new SessionMonitor({ maxSessions: 10, maxNodesPerSession: 10 });
monitor.createSession("older-session", 1000);
monitor.createSession("newer-session", 2000);

const first = monitor.beginTool({
  sessionId: "older-session",
  tool: "open_workspace",
  input: { path: "C:\\projects\\arcaia" },
  workspaceLabel: "arcaia",
});
monitor.completeTool(first, { structuredContent: { workspaceId: "ws-1" } });

const second = monitor.beginTool({
  sessionId: "older-session",
  tool: "exec_command",
  input: { workspaceId: "ws-1", cmd: "npm test" },
  workspaceId: "ws-1",
  workspaceLabel: "arcaia",
});
monitor.completeTool(second, { structuredContent: { running: false, exitCode: 0 } });

const snapshot = monitor.snapshot();
assert.deepEqual(snapshot.sessions.map((session) => session.sessionIdPrefix), ["newer-se", "older-se"]);
assert.equal(snapshot.sessions[1]?.totalCalls, 2);
assert.deepEqual(snapshot.sessions[1]?.nodes.map((node) => node.number), [1, 2]);
assert.equal(snapshot.sessions[1]?.state, "idle");
assert.equal(snapshot.sessions[1]?.workspaceLabel, "arcaia");
assert.deepEqual(classifyToolResult({ structuredContent: { running: true } }), {
  nodeState: "waiting", sessionState: "waiting", exitCode: undefined,
});
assert.deepEqual(classifyToolResult({ structuredContent: { exitCode: 1 } }), {
  nodeState: "error", sessionState: "error", exitCode: 1,
});
assert.equal(summarizeToolTarget("read", { path: "src/main.ts" }), "src/main.ts");
assert.equal(summarizeToolTarget("write_stdin", { chars: "" }), "poll");
assert.equal(workspaceLabelFromPath("C:\\projects\\workbridge\\"), "workbridge");
