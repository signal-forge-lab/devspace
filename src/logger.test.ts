import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
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
  loggedCommandFields(config, "launch_workspace_task", "python task.py", 14),
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
