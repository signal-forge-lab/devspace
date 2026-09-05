import assert from "node:assert/strict";
import {
  classifyToolResult,
  SessionMonitor,
  summarizeToolTarget,
  workspaceDisplayInfo,
  workspaceIdDisplayToken,
  workspaceLabelFromPath,
} from "./session-monitor.js";

const monitor = new SessionMonitor({ maxSessions: 10, maxNodesPerSession: 10 });
assert.equal(monitor.snapshot().revision, 0);

const openWorkspace = monitor.beginTool({
  operationId: "op-open",
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
  operationId: "op-command",
  transportSessionId: "different-mcp-session",
  workspaceId: "ws_1234567890-aaaa-bbbb-cccc-1234567890ab",
  workspaceStartedAt: 1000,
  tool: "exec_command",
  input: { workspaceId: "ws_1234567890-aaaa-bbbb-cccc-1234567890ab", cmd: "npm test" },
  workspaceLabel: "arcaia",
});
monitor.completeTool(command, { structuredContent: { running: false, exitCode: 0 } });

const newer = monitor.beginTool({
  operationId: "op-newer",
  transportSessionId: "third-mcp-session",
  workspaceId: "ws_abcdefghij",
  workspaceStartedAt: 2000,
  tool: "read",
  input: { path: "README.md" },
  workspaceLabel: "workbridge",
});
monitor.completeTool(newer, { structuredContent: {} });

const snapshot = monitor.snapshot();
assert.equal(snapshot.version, 5);
assert.equal(snapshot.revision, 6);
assert.equal(snapshot.sessions.length, 2);
assert.deepEqual(snapshot.sessions.map((session) => session.displayId), [
  "abcdefghij",
  "1234567890",
]);
assert.equal(snapshot.sessions[1]?.totalCalls, 2);
assert.deepEqual(snapshot.sessions[1]?.nodes.map((node) => node.number), [1, 2]);
assert.deepEqual(snapshot.sessions[1]?.nodes.map((node) => node.tool), ["open_workspace", "exec_command"]);
assert.equal(snapshot.sessions[1]?.state, "idle");
assert.equal(snapshot.sessions[1]?.workspaceLabel, "arcaia");
assert.equal(snapshot.sessions[1]?.workspacePath, "C:\\projects\\arcaia");
assert.equal(snapshot.sessions[1]?.nodes[1]?.nodeId, command.nodeId);
assert.equal(snapshot.sessions[1]?.nodes[1]?.operationId, "op-command");
monitor.updateTool(command, { commandDisplay: "npm test", shell: "cmd.exe" });
assert.equal(monitor.operation("op-command")?.displayId, "1234567890");
assert.equal(monitor.operation("op-command")?.details.commandDisplay, "npm test");
assert.equal("details" in (monitor.snapshot().sessions[1]?.nodes[1] ?? {}), false);

const boundedDetailsMonitor = new SessionMonitor({
  maxSessions: 2,
  maxNodesPerSession: 4,
  maxOperationDetails: 1,
});
const firstDetailed = boundedDetailsMonitor.beginTool({
  operationId: "op-first-detail",
  workspaceId: "ws_details",
  tool: "exec_command",
  input: { cmd: "first" },
});
boundedDetailsMonitor.updateTool(firstDetailed, { commandDisplay: "first" });
const secondDetailed = boundedDetailsMonitor.beginTool({
  operationId: "op-second-detail",
  workspaceId: "ws_details",
  tool: "exec_command",
  input: { cmd: "second" },
});
boundedDetailsMonitor.updateTool(secondDetailed, { commandDisplay: "second" });
assert.deepEqual(boundedDetailsMonitor.operation("op-first-detail")?.details, {});
assert.equal(boundedDetailsMonitor.operation("op-second-detail")?.details.commandDisplay, "second");

const unchangedRevision = monitor.snapshot().revision;
assert.equal(monitor.snapshot().revision, unchangedRevision);

await new Promise((resolve) => setTimeout(resolve, 2));
const reactivated = monitor.beginTool({
  operationId: "op-reactivated",
  workspaceId: "ws_1234567890-aaaa-bbbb-cccc-1234567890ab",
  workspaceStartedAt: 1000,
  tool: "read",
  input: { path: "src/session-monitor.ts" },
  workspaceLabel: "arcaia",
});
monitor.completeTool(reactivated, { structuredContent: {} });
assert.equal(monitor.snapshot().revision, unchangedRevision + 2);
assert.deepEqual(
  monitor.snapshot(20, 20, "startedAt").sessions.map((session) => session.displayId),
  ["abcdefghij", "1234567890"],
);
assert.deepEqual(
  monitor.snapshot(20, 20, "lastActivityAt").sessions.map((session) => session.displayId),
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
assert.equal(
  summarizeToolTarget("exec_command", { cmd: "API_KEY=secret npm test" }),
  "API_KEY=[REDACTED] npm test",
);
assert.equal(workspaceLabelFromPath("C:\\projects\\workbridge\\"), "workbridge");
assert.equal(workspaceIdDisplayToken("ws_a1b2c3d4e5"), "a1b2c3d4e5");
assert.equal(workspaceIdDisplayToken("ws_d2bbd5eb-67eb-40dc-9394-80eefd5750e2"), "d2bbd5eb-6");

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
