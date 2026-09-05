import assert from "node:assert/strict";
import {
  captureMonitorToolLog,
  currentMonitorOperationDetails,
  currentMonitorOperationId,
  runMonitorOperation,
  sanitizeMonitorCommand,
} from "./monitor-operation-context.js";

const updates: unknown[] = [];
await runMonitorOperation("op-test", (details) => updates.push(details), async () => {
  assert.equal(currentMonitorOperationId(), "op-test");
  captureMonitorToolLog({
    tool: "exec_command",
    workspaceId: "ws_test",
    command: "API_KEY=secret curl -H \"Authorization: Bearer token-value\" https://example.test/?token=query-secret",
    workingDirectory: ".",
    shell: "cmd.exe",
    sessionId: 7,
    running: true,
    outputTruncated: false,
  });
  const details = currentMonitorOperationDetails();
  assert.equal(details.commandDisplay?.includes("secret"), false);
  assert.equal(details.commandDisplay?.includes("token-value"), false);
  assert.equal(details.commandDisplay?.includes("query-secret"), false);
  assert.match(details.commandDisplay ?? "", /\[REDACTED\]/);
  assert.equal(details.shell, "cmd.exe");
  assert.equal(details.sessionId, 7);
});
assert.ok(updates.length > 0);

await runMonitorOperation("op-poll", () => undefined, async () => {
  captureMonitorToolLog({
    tool: "write_stdin",
    workspaceId: "ws_test",
    sessionId: 7,
    running: false,
  });
  const details = currentMonitorOperationDetails();
  assert.match(details.commandDisplay ?? "", /curl/);
  assert.equal(details.parentSessionId, 7);
});

const oversized = sanitizeMonitorCommand("x".repeat(40_000));
assert.equal(oversized.commandDisplay?.length, 32 * 1024);
assert.equal(oversized.commandTruncated, true);
assert.match(oversized.commandDisplay ?? "", /command truncated/);

const additionalSecrets = sanitizeMonitorCommand(
  'curl -u user:password -H "X-API-Key: header-secret" -H "Cookie: session=hidden" https://user:pass@example.test/',
).commandDisplay ?? "";
assert.equal(additionalSecrets.includes("password"), false);
assert.equal(additionalSecrets.includes("header-secret"), false);
assert.equal(additionalSecrets.includes("session=hidden"), false);
assert.equal(additionalSecrets.includes("user:pass@"), false);
assert.match(additionalSecrets, /\[REDACTED\]/);
