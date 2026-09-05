import assert from "node:assert/strict";
import { createMonitorLogView } from "./monitor-log-view.js";

const readView = createMonitorLogView("info", "tool_call", {
  tool: "read",
  workspaceId: "ws_1234567890-aaaa-bbbb-cccc-1234567890ab",
  path: "src/server.ts",
  success: true,
  durationMs: 12,
}, {
  ts: "2026-07-30T00:00:00.000Z",
  level: "info",
  event: "tool_call",
});
assert.equal(readView.kind, "read");
assert.equal(readView.status, "success");
assert.equal(readView.workspace, "1234567890");
assert.equal(readView.operation, "read");
assert.equal(readView.durationMs, 12);
assert.equal(readView.summary, "src/server.ts");
assert.deepEqual(readView.details, {
  path: "src/server.ts",
  workspaceId: "ws_1234567890-aaaa-bbbb-cccc-1234567890ab",
  tool: "read",
  success: true,
  durationMs: 12,
});

const commandView = createMonitorLogView("info", "tool_call", {
  tool: "exec_command",
  operationId: "op-command",
  workspaceId: "ws_1234567890-aaaa-bbbb-cccc-1234567890ab",
  commandPreview: "npm run verify:rebase",
  command: "secret command must not be copied",
  success: true,
  durationMs: 8_400,
  exitCode: 0,
}, {
  ts: "2026-07-30T00:00:01.000Z",
  level: "info",
  event: "tool_call",
});
assert.equal(commandView.kind, "run");
assert.equal(commandView.operationId, "op-command");
assert.equal(commandView.summary, "npm run verify:rebase");
assert.equal(commandView.details.commandPreview, "npm run verify:rebase");
assert.equal(commandView.details.operationId, "op-command");
assert.equal("commandDisplay" in commandView.details, false);

const failedCommandView = createMonitorLogView("warn", "tool_call", {
  tool: "exec_command",
  commandPreview: "node failing-script.js",
  success: false,
  running: false,
  exitCode: 7,
}, {
  ts: "2026-07-30T00:00:01.500Z",
  level: "warn",
  event: "tool_call",
});
assert.equal(failedCommandView.status, "error");
assert.equal(failedCommandView.details.exitCode, 7);
assert.equal("command" in commandView.details, false);

const skippedView = createMonitorLogView("info", "tool_call", {
  tool: "run_workspace_action",
  action: "workspace_verify",
  executed: false,
  executionPolicy: "invalid_working_directory",
}, {
  ts: "2026-07-30T00:00:02.000Z",
  level: "info",
  event: "tool_call",
});
assert.equal(skippedView.status, "skipped");
assert.equal(skippedView.error, false);

const pressureView = createMonitorLogView("warn", "mcp_session_pressure", {
  active: 128,
  activeRequests: 1,
  toolCallSessions: 10,
  oneShotCleanupCandidates: 10,
  threshold: 128,
}, {
  ts: "2026-07-30T00:00:03.000Z",
  level: "warn",
  event: "mcp_session_pressure",
});
assert.equal(pressureView.kind, "session");
assert.equal(pressureView.status, "warning");
assert.equal(pressureView.workspace, "mcp");
assert.match(pressureView.summary, /Session pressure/);

const modernView = createMonitorLogView("info", "mcp_modern_probe_detected", {
  protocolEra: "modern",
  protocolVersion: "2026-07-28",
  rpcMethod: "tools/call",
  mcpMethodHeader: "tools/call",
  mcpNameHeader: "open_workspace",
  clientName: "openai-mcp",
  clientVersion: "2.0.0",
  clientCapabilitiesPresent: true,
  signals: ["protocol_version_header", "protocol_version_meta"],
}, {
  ts: "2026-08-11T00:00:00.000Z",
  level: "info",
  event: "mcp_modern_probe_detected",
});
assert.equal(modernView.kind, "session");
assert.equal(modernView.summary, "Modern MCP · tools/call · open_workspace · 2026-07-28");
assert.equal(modernView.details.protocolEra, "modern");
assert.equal(modernView.details.clientName, "openai-mcp");
assert.deepEqual(modernView.details.signals, ["protocol_version_header", "protocol_version_meta"]);

const oauthChallenge = createMonitorLogView("info", "http_request", {
  method: "POST",
  path: "/mcp",
  status: 401,
  classification: "auth",
}, {
  ts: "2026-08-11T00:00:01.000Z",
  level: "info",
  event: "http_request",
});
assert.equal(oauthChallenge.status, "info");
assert.equal(oauthChallenge.error, false);
assert.equal(oauthChallenge.summary, "OAuth challenge · POST /mcp · code 401");

const oauthDiscoveryProbe = createMonitorLogView("info", "http_request", {
  method: "GET",
  path: "/mcp/.well-known/oauth-authorization-server",
  status: 404,
  classification: "probe",
}, {
  ts: "2026-08-11T00:00:02.000Z",
  level: "info",
  event: "http_request",
});
assert.equal(oauthDiscoveryProbe.status, "info");
assert.equal(oauthDiscoveryProbe.error, false);
assert.match(oauthDiscoveryProbe.summary, /^OAuth discovery probe/);

const unexpectedNotFound = createMonitorLogView("info", "http_request", {
  method: "GET",
  path: "/missing",
  status: 404,
  classification: "error",
}, {
  ts: "2026-08-11T00:00:03.000Z",
  level: "info",
  event: "http_request",
});
assert.equal(unexpectedNotFound.status, "error");

const routineModernMcpHttp = createMonitorLogView("info", "http_request", {
  method: "POST",
  path: "/mcp",
  status: 200,
  classification: "request",
}, {
  ts: "2026-08-11T00:00:04.000Z",
  level: "info",
  event: "http_request",
});
assert.equal(routineModernMcpHttp.details.routineMcpHttp, true);
assert.equal(unexpectedNotFound.details.routineMcpHttp, undefined);

const abnormalModernMcpHttp = createMonitorLogView("warn", "http_request", {
  method: "POST",
  path: "/mcp",
  status: 200,
  classification: "request",
  requestAborted: true,
}, {
  ts: "2026-08-11T00:00:05.000Z",
  level: "warn",
  event: "http_request",
});
assert.equal(abnormalModernMcpHttp.details.routineMcpHttp, undefined);
assert.equal(abnormalModernMcpHttp.status, "warning");
