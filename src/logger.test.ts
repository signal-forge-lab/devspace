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
    format: "pretty",
    requests: true,
    assets: false,
    toolCalls: true,
    shellCommands: false,
    trustProxy: false,
    file: true,
    filePath,
  };

  logEvent(config, "info", "test_event", { value: 42 });
  await closeLogFiles();

  const lines = (await readFile(filePath, "utf8")).trim().split("\n");
  assert.equal(lines.length, 1);
  const entry = JSON.parse(lines[0]) as Record<string, unknown>;
  assert.equal(entry.event, "test_event");
  assert.equal(entry.level, "info");
  assert.equal(entry.value, 42);

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
