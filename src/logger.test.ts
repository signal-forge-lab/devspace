import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  classifyHttpRequest,
  compactClientKind,
  errorLogFields,
  loggedCommandFields,
  logEvent,
  sanitizeRequestUrlForLog,
  shouldSuppressSuccessfulMonitorPoll,
  type LoggingConfig,
} from "./logger.js";
import { monitorLogStream } from "./monitor-log-stream.js";

assert.equal(compactClientKind("OpenAI/ChatGPT"), "openai");
assert.equal(compactClientKind("claude-ai"), "claude");
assert.equal(compactClientKind("Python/3.12 aiohttp/3.9"), "python");
assert.equal(compactClientKind("python-requests/2.32"), "python");
assert.equal(compactClientKind("curl/8.5.0"), "curl");
assert.equal(compactClientKind("Mozilla/5.0 Chrome/120 Safari/537.36"), "browser");
assert.equal(compactClientKind("zgrab/0.x"), "scanner");
assert.equal(compactClientKind(""), "unknown");
assert.equal(classifyHttpRequest("/mcp", 401), "auth");
assert.equal(classifyHttpRequest("/mcp", 403), "auth");
assert.equal(classifyHttpRequest("/.well-known/openid-configuration", 404), "probe");
assert.equal(classifyHttpRequest("/mcp/.well-known/oauth-authorization-server", 404), "probe");
assert.equal(classifyHttpRequest("/mcp", 404), "error");
assert.equal(classifyHttpRequest("/mcp", 200), "request");
assert.equal(
  sanitizeRequestUrlForLog("https://example.test/authorize?state=secret#fragment"),
  "https://example.test/authorize",
);
assert.equal(sanitizeRequestUrlForLog("/authorize?state=secret"), "/authorize");

const rootCause = new Error("root cause");
rootCause.stack = "Error: root cause\n    at root";
const outerError = new Error("outer failure", { cause: rootCause });
outerError.stack = "Error: outer failure\n    at outer";
assert.deepEqual(errorLogFields(outerError), {
  error: "outer failure",
  errorName: "Error",
  errorStack: "Error: outer failure\n    at outer",
  errorCause: {
    name: "Error",
    message: "root cause",
    stack: "Error: root cause\n    at root",
  },
});
assert.deepEqual(errorLogFields("plain failure"), { error: "plain failure" });

const logDir = mkdtempSync(join(tmpdir(), "devspace-logger-test-"));
const logPath = join(logDir, "devspace.jsonl");
const config: LoggingConfig = {
  level: "info",
  format: "json",
  file: true,
  filePath: logPath,
  fileMaxBytes: 240,
  fileMaxFiles: 3,
  requests: true,
  assets: false,
  toolCalls: true,
  shellCommands: false,
  trustProxy: false,
};

assert.deepEqual(
  loggedCommandFields(config, "exec_command", "echo secret-value", 17),
  {},
);
assert.deepEqual(
  loggedCommandFields(config, "run_workspace_action", "python task.py", 14),
  {},
);
assert.deepEqual(
  loggedCommandFields({ shellCommands: true }, "write_stdin", "secret input", 12),
  {},
);
assert.deepEqual(
  loggedCommandFields({ shellCommands: true }, "exec_command", "  npm   test  ", 14),
  { commandPreview: "npm test", commandLength: 14 },
);
assert.deepEqual(
  loggedCommandFields(
    config,
    "exec_command",
    "npx -y @nanonets/graft@0.10.1 --dir \"C:\\repo map\\graph\" callers WorkspaceRegistry.openWorkspace . --json",
    106,
  ),
  { commandKind: "graft", commandAction: "callers" },
);
assert.deepEqual(
  loggedCommandFields(config, "exec_command", "rg -n secret-value src", 22),
  { commandKind: "rg" },
);
assert.deepEqual(
  loggedCommandFields(
    config,
    "exec_command",
    "npx -y @nanonets/graft@0.10.1 map . --json && rg -n secret-value src",
    72,
  ),
  { commandKind: "mixed", commandAction: "map" },
);
assert.deepEqual(
  loggedCommandFields(config, "exec_command", "echo rg secret-value", 20),
  {},
);
assert.deepEqual(
  loggedCommandFields(
    { shellCommands: true },
    "exec_command",
    "API_KEY=secret curl -H \"Authorization: Bearer token\" https://example.test/?token=query",
    86,
  ),
  {
    commandPreview: "API_KEY=[REDACTED] curl -H \"Authorization: Bearer [REDACTED]\" https://example.test/?token=[REDACTED]",
    commandLength: 86,
  },
);

const originalConsoleLog = console.log;
console.log = () => undefined;
try {
  for (let index = 0; index < 8; index += 1) {
    logEvent(config, "info", "http_request", {
      method: "POST",
      path: "/mcp",
      status: 200,
      durationMs: 1,
      userAgent: "OpenAI/ChatGPT",
      sequence: index,
      padding: "x".repeat(80),
    });
  }
} finally {
  console.log = originalConsoleLog;
}

assert.equal(existsSync(logPath), true);
assert.equal(existsSync(`${logPath}.1`), true);
assert.equal(existsSync(`${logPath}.2`), true);
assert.equal(existsSync(`${logPath}.3`), false);
assert.ok(statSync(logPath).size > 0);
assert.match(readFileSync(logPath, "utf8"), /"event":"http_request"/);

assert.equal(shouldSuppressSuccessfulMonitorPoll("GET", "/monitor/api/snapshot", 200, false), true);
assert.equal(shouldSuppressSuccessfulMonitorPoll("GET", "/monitor/api/status", 204, false), true);
assert.equal(shouldSuppressSuccessfulMonitorPoll("GET", "/monitor/api/status", 500, false), false);
assert.equal(shouldSuppressSuccessfulMonitorPoll("GET", "/monitor/api/status", 200, true), false);
assert.equal(shouldSuppressSuccessfulMonitorPoll("POST", "/monitor/api/status", 200, false), false);
assert.equal(shouldSuppressSuccessfulMonitorPoll("GET", "/monitor/api/logs", 200, false), false);

const jsonConsoleLines: string[] = [];
const originalJsonConsoleLog = console.log;
console.log = (line?: unknown) => jsonConsoleLines.push(String(line));
try {
  logEvent({ ...config, file: false }, "info", "mcp_session_metrics", {
    active: 12,
    activeRequests: 2,
    initializedOnly: 3,
    handshakeOnly: 2,
    discoveryOnly: 4,
    operational: 3,
    toolCallSessions: 3,
    oneShotCleanupCandidates: 2,
    reusedToolCallSessions: 1,
    maxToolCallsPerSession: 2,
    rssBytes: 128 * 1024 * 1024,
    heapUsedBytes: 64 * 1024 * 1024,
  });
} finally {
  console.log = originalJsonConsoleLog;
}
assert.equal(jsonConsoleLines.length, 1);
const jsonConsoleEntry = JSON.parse(jsonConsoleLines[0] ?? "{}") as Record<string, unknown>;
assert.equal(jsonConsoleEntry.level, "info");
assert.equal(jsonConsoleEntry.event, "mcp_session_metrics");
assert.equal(jsonConsoleEntry.active, 12);
assert.equal(jsonConsoleEntry.activeRequests, 2);
assert.doesNotMatch(jsonConsoleLines[0] ?? "", /MCPSESS|\s\|\s/);

const prettyConsoleLines: string[] = [];
const originalPrettyConsoleWarn = console.warn;
console.warn = (line?: unknown) => prettyConsoleLines.push(String(line));
try {
  logEvent({ ...config, file: false, format: "pretty" }, "warn", "mcp_session_pressure", {
    threshold: 128,
    active: 128,
    activeRequests: 1,
    initializedOnly: 100,
    handshakeOnly: 8,
    discoveryOnly: 10,
    operational: 10,
    toolCallSessions: 10,
    oneShotCleanupCandidates: 10,
    reusedToolCallSessions: 0,
    maxToolCallsPerSession: 1,
    rssBytes: 256 * 1024 * 1024,
    heapUsedBytes: 96 * 1024 * 1024,
  });
} finally {
  console.warn = originalPrettyConsoleWarn;
}
assert.equal(prettyConsoleLines.length, 1);
assert.match(prettyConsoleLines[0] ?? "", / WARN mcp_session_pressure /);
assert.match(prettyConsoleLines[0] ?? "", /threshold=128/);
assert.match(prettyConsoleLines[0] ?? "", /active=128/);
assert.doesNotMatch(prettyConsoleLines[0] ?? "", /MCPWARN|\s\|\s/);

const beforeMonitorSequence = monitorLogStream.snapshot().latestSequence;
const originalMonitorConsoleLog = console.log;
console.log = () => undefined;
try {
  logEvent({ ...config, file: false }, "info", "tool_call", {
    tool: "read",
    workspaceId: "ws_1234567890-aaaa-bbbb-cccc-1234567890ab",
    path: "README.md",
    success: true,
    durationMs: 3,
  });
} finally {
  console.log = originalMonitorConsoleLog;
}
const monitorLogs = monitorLogStream.snapshot(beforeMonitorSequence).logs;
assert.equal(monitorLogs.length, 1);
assert.equal(monitorLogs[0]?.kind, "read");
assert.equal(monitorLogs[0]?.status, "success");
assert.equal(monitorLogs[0]?.error, false);
assert.equal(monitorLogs[0]?.tool, "read");
assert.equal(monitorLogs[0]?.workspaceId, "ws_1234567890-aaaa-bbbb-cccc-1234567890ab");
assert.equal(monitorLogs[0]?.operation, "read");
assert.equal(monitorLogs[0]?.summary, "README.md");
assert.deepEqual(monitorLogs[0]?.details, {
  path: "README.md",
  workspaceId: "ws_1234567890-aaaa-bbbb-cccc-1234567890ab",
  tool: "read",
  success: true,
  durationMs: 3,
});
