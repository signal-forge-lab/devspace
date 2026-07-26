import assert from "node:assert/strict";
import {
  classifyToolResult,
  SessionMonitor,
  summarizeToolTarget,
  workspaceDisplayInfo,
  workspaceIdCompactPrefix,
  workspaceLabelFromPath,
} from "./session-monitor.js";

const monitor = new SessionMonitor({ maxSessions: 10, maxNodesPerSession: 10 });

const openWorkspace = monitor.beginTool({
  transportSessionId: "transport-open",
  tool: "open_workspace",
  input: { path: "C:\\projects\\arcaia" },
  workspaceLabel: "arcaia",
});
monitor.completeTool(
  openWorkspace,
  { structuredContent: { workspaceId: "ws_1234567890-aaaa-bbbb-cccc-1234567890ab" } },
  {
    workspaceId: "ws_1234567890-aaaa-bbbb-cccc-1234567890ab",
    workspaceLabel: "arcaia",
    workspacePath: "C:\\projects\\arcaia",
    startedAt: 1000,
  },
);

const command = monitor.beginTool({
  transportSessionId: "different-mcp-session",
  workspaceId: "ws_1234567890-aaaa-bbbb-cccc-1234567890ab",
  workspaceStartedAt: 1000,
  tool: "exec_command",
  input: { workspaceId: "ws_1234567890-aaaa-bbbb-cccc-1234567890ab", cmd: "npm test" },
  workspaceLabel: "arcaia",
});
monitor.completeTool(command, { structuredContent: { running: false, exitCode: 0 } });

const newer = monitor.beginTool({
  transportSessionId: "third-mcp-session",
  workspaceId: "ws_abcdefghij-aaaa-bbbb-cccc-1234567890ab",
  workspaceStartedAt: 2000,
  tool: "read",
  input: { path: "README.md" },
  workspaceLabel: "workbridge",
});
monitor.completeTool(newer, { structuredContent: {} });

const snapshot = monitor.snapshot();
assert.equal(snapshot.version, 2);
assert.equal(snapshot.sessions.length, 2);
assert.deepEqual(snapshot.sessions.map((session) => session.sessionIdPrefix), [
  "abcdefghij",
  "1234567890",
]);
assert.equal(snapshot.sessions[1]?.totalCalls, 2);
assert.deepEqual(snapshot.sessions[1]?.nodes.map((node) => node.number), [1, 2]);
assert.deepEqual(snapshot.sessions[1]?.nodes.map((node) => node.tool), ["open_workspace", "exec_command"]);
assert.equal(snapshot.sessions[1]?.state, "idle");
assert.equal(snapshot.sessions[1]?.workspaceLabel, "arcaia");
assert.equal(snapshot.sessions[1]?.workspacePath, "C:\\projects\\arcaia");

await new Promise((resolve) => setTimeout(resolve, 2));
const reactivated = monitor.beginTool({
  workspaceId: "ws_1234567890-aaaa-bbbb-cccc-1234567890ab",
  workspaceStartedAt: 1000,
  tool: "read",
  input: { path: "src/session-monitor.ts" },
  workspaceLabel: "arcaia",
});
monitor.completeTool(reactivated, { structuredContent: {} });
assert.deepEqual(
  monitor.snapshot(20, 20, "startedAt").sessions.map((session) => session.sessionIdPrefix),
  ["abcdefghij", "1234567890"],
);
assert.deepEqual(
  monitor.snapshot(20, 20, "lastActivityAt").sessions.map((session) => session.sessionIdPrefix),
  ["1234567890", "abcdefghij"],
);

assert.deepEqual(classifyToolResult({ structuredContent: { running: true } }), {
  nodeState: "waiting", sessionState: "waiting", exitCode: undefined,
});
assert.deepEqual(classifyToolResult({ structuredContent: { exitCode: 1 } }), {
  nodeState: "error", sessionState: "error", exitCode: 1,
});
assert.equal(summarizeToolTarget("read", { path: "src/main.ts" }), "src/main.ts");
assert.equal(summarizeToolTarget("write_stdin", { chars: "" }), "poll");
assert.equal(workspaceLabelFromPath("C:\\projects\\workbridge\\"), "workbridge");
assert.equal(workspaceIdCompactPrefix("ws_d2bbd5eb-67eb-40dc-9394-80eefd5750e2"), "d2bbd5eb-6");

assert.deepEqual(
  workspaceDisplayInfo("C:\\devops\\aegis_gate_worktrees\\next"),
  {
    label: "aegis_gate",
    detail: "worktree: next",
    path: "C:\\devops\\aegis_gate_worktrees\\next",
  },
);
assert.deepEqual(
  workspaceDisplayInfo(
    "C:\\temp\\managed-worktree-1234",
    "C:\\devops\\aegis_gate",
  ),
  {
    label: "aegis_gate",
    detail: "worktree: managed-worktree-1234",
    path: "C:\\temp\\managed-worktree-1234",
  },
);
