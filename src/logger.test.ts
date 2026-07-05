import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeLogFiles, logEvent, requestCorrelationFields, type LoggingConfig } from "./logger.js";

const root = await mkdtemp(join(tmpdir(), "devspace-logger-test-"));
try {
  const filePath = join(root, "logs", "devspace_test.jsonl");
  const config: LoggingConfig = {
    level: "info",
    consoleLevel: "warn",
    format: "pretty",
    requests: true,
    assets: false,
    toolCalls: true,
    shellCommands: false,
    trustProxy: false,
    file: true,
    filePath,
  };

  const originalLog = console.log;
  const consoleLines: string[] = [];
  console.log = (line?: unknown) => {
    consoleLines.push(String(line));
  };
  try {
    logEvent(config, "info", "test_event", { value: 42 });
  } finally {
    console.log = originalLog;
  }
  assert.deepEqual(consoleLines, []);
  await closeLogFiles();

  const lines = (await readFile(filePath, "utf8")).trim().split("\n");
  assert.equal(lines.length, 1);
  const entry = JSON.parse(lines[0]) as Record<string, unknown>;
  assert.equal(entry.event, "test_event");
  assert.equal(entry.level, "info");
  assert.equal(entry.value, 42);

  const compactFilePath = join(root, "logs", "devspace_compact_test.jsonl");
  const compactConfig: LoggingConfig = {
    ...config,
    filePath: compactFilePath,
  };

  const originalCompactLog = console.log;
  const originalCompactWarn = console.warn;
  const consoleLogLines: string[] = [];
  const consoleWarnLines: string[] = [];
  console.log = (line?: unknown) => {
    consoleLogLines.push(String(line));
  };
  console.warn = (line?: unknown) => {
    consoleWarnLines.push(String(line));
  };
  try {
    logEvent(compactConfig, "info", "tool_call", {
      tool: "read",
      success: true,
      durationMs: 12,
      path: "src/logger.ts",
      workspaceId: "ws_abc1234567-extra",
    });
    logEvent(compactConfig, "info", "tool_call", {
      tool: "apply_patch",
      success: true,
      durationMs: 42,
      fileCount: 2,
      workspaceId: "ws_abc1234567-extra",
    });
    logEvent(compactConfig, "warn", "tool_call", {
      tool: "exec_command",
      success: false,
      durationMs: 30_000,
      exitCode: 1,
      error: "timeout",
      workspaceId: "ws_abc1234567-extra",
    });
  } finally {
    console.log = originalCompactLog;
    console.warn = originalCompactWarn;
  }

  assert.deepEqual(consoleLogLines, ["abc1234567 | 変更   | apply_patch            | ok     | 42ms     | files=2"]);
  assert.deepEqual(consoleWarnLines, ["abc1234567 | 失敗   | exec_command           | failed | 30s      | exit=1 reason=timeout"]);
  await closeLogFiles();

  const compactLines = (await readFile(compactFilePath, "utf8")).trim().split("\n");
  assert.equal(compactLines.length, 3);
  assert.equal(JSON.parse(compactLines[0]).tool, "read");

  const req = {
    header(name: string): string | undefined {
      const headers: Record<string, string> = {
        "x-chatgpt-conversation-id": "conversation-secret-value",
      };
      return headers[name.toLowerCase()];
    },
  };
  const correlation = requestCorrelationFields(req as never, {
    requestId: "12345678-1234-1234-1234-123456789012",
    sessionId: "abcdef12-3456-7890-abcd-ef1234567890",
  });
  assert.equal(correlation.conversationIdHeader, "x-chatgpt-conversation-id");
  assert.equal(typeof correlation.conversationIdHash, "string");
  assert.equal(String(correlation.conversationIdHash).length, 12);
  assert.notEqual(correlation.conversationIdHash, "conversation-secret-value");
  assert.equal(correlation.sessionIdPrefix, "abcdef12");
  assert.equal(correlation.requestIdPrefix, "12345678");
  assert.equal(correlation.autoThreadId, `conversation:${correlation.conversationIdHash}`);
} finally {
  await closeLogFiles();
  await rm(root, { recursive: true, force: true });
}
