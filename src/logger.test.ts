import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  classifyHttpRequest,
  compactClientKind,
  loggedCommandFields,
  logEvent,
  type LoggingConfig,
} from "./logger.js";

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
assert.equal(classifyHttpRequest("/mcp", 404), "error");
assert.equal(classifyHttpRequest("/mcp", 200), "request");

const logDir = mkdtempSync(join(tmpdir(), "devspace-logger-test-"));
const logPath = join(logDir, "devspace.jsonl");
const config: LoggingConfig = {
  level: "info",
  format: "json",
  file: true,
  filePath: logPath,
  fileMaxBytes: 240,
  fileMaxFiles: 3,
  consoleJson: false,
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

const sessionConsoleLines: string[] = [];
const originalSessionConsoleLog = console.log;
const originalSessionConsoleWarn = console.warn;
console.log = (line?: unknown) => sessionConsoleLines.push(String(line));
console.warn = (line?: unknown) => sessionConsoleLines.push(String(line));
try {
  logEvent({ ...config, file: false }, "info", "mcp_session_metrics", {
    active: 12,
    initializedOnly: 3,
    handshakeOnly: 2,
    discoveryOnly: 4,
    operational: 3,
    toolCallSessions: 3,
    reusedToolCallSessions: 1,
    maxToolCallsPerSession: 2,
    rssBytes: 128 * 1024 * 1024,
    heapUsedBytes: 64 * 1024 * 1024,
  });
  logEvent({ ...config, file: false }, "warn", "mcp_session_pressure", {
    threshold: 128,
    active: 128,
    initializedOnly: 100,
    handshakeOnly: 8,
    discoveryOnly: 10,
    operational: 10,
    toolCallSessions: 10,
    reusedToolCallSessions: 0,
    maxToolCallsPerSession: 1,
    rssBytes: 256 * 1024 * 1024,
    heapUsedBytes: 96 * 1024 * 1024,
  });
} finally {
  console.log = originalSessionConsoleLog;
  console.warn = originalSessionConsoleWarn;
}
assert.equal(sessionConsoleLines.length, 2);
assert.match(sessionConsoleLines[0] ?? "", /MCPSESS/);
assert.equal((sessionConsoleLines[0] ?? "").split(" | ")[2], "MCPSESS");
assert.equal((sessionConsoleLines[1] ?? "").split(" | ")[2], "MCPWARN");
assert.match(sessionConsoleLines[0] ?? "", /active=12/);
assert.match(sessionConsoleLines[0] ?? "", /toolSessions=3/);
assert.match(sessionConsoleLines[0] ?? "", /reused=1/);
assert.match(sessionConsoleLines[0] ?? "", /maxCalls=2/);
assert.match(sessionConsoleLines[0] ?? "", /rss=128\.0MiB/);
assert.match(sessionConsoleLines[1] ?? "", /MCPWARN/);
assert.match(sessionConsoleLines[1] ?? "", /threshold=128/);


const alignedConsoleLines: string[] = [];
const originalAlignedConsoleLog = console.log;
console.log = (line?: unknown) => alignedConsoleLines.push(String(line));
try {
  logEvent({ ...config, file: false }, "info", "http_request", {
    method: "POST",
    path: "/mcp",
    status: 200,
    durationMs: 1,
    ip: "20.210.174.221",
  });
  logEvent({ ...config, file: false }, "info", "mcp_session_metrics", {
    active: 5,
    initializedOnly: 0,
    handshakeOnly: 0,
    discoveryOnly: 0,
    operational: 5,
    toolCallSessions: 5,
    reusedToolCallSessions: 0,
    maxToolCallsPerSession: 1,
    rssBytes: 0,
    heapUsedBytes: 0,
  });
} finally {
  console.log = originalAlignedConsoleLog;
}
assert.equal(alignedConsoleLines.length, 2);
for (const line of alignedConsoleLines) {
  const columns = line.split(" | ");
  assert.equal(columns[2]?.length, 7);
  assert.equal(columns[3]?.length, 19);
  assert.equal(columns[4]?.length, 7);
}
assert.equal(alignedConsoleLines[0]?.split(" | ")[2], "HTTP   ");
assert.equal(alignedConsoleLines[0]?.split(" | ")[3], "http_request       ");
assert.equal(alignedConsoleLines[1]?.split(" | ")[2], "MCPSESS");
assert.equal(alignedConsoleLines[1]?.split(" | ")[3], "sessions           ");

const skippedToolConsoleLines: string[] = [];
const originalSkippedToolConsoleLog = console.log;
console.log = (line?: unknown) => skippedToolConsoleLines.push(String(line));
try {
  logEvent({ ...config, file: false }, "info", "tool_call", {
    tool: "exec_command",
    workspaceId: "ws_policy_test",
    success: true,
    executed: false,
    executionPolicy: "sandbox_bundle",
    durationMs: 0,
  });
} finally {
  console.log = originalSkippedToolConsoleLog;
}
assert.equal(skippedToolConsoleLines.length, 1);
assert.match(skippedToolConsoleLines[0] ?? "", /SKIP/);
assert.match(skippedToolConsoleLines[0] ?? "", /skip/);
assert.match(skippedToolConsoleLines[0] ?? "", /policy=sandbox_bundle/);
