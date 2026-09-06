import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ServerConfig } from "./config.js";
import type { CodebaseMemoryManager } from "./codebase-memory-code-intelligence.js";
import type { ProcessSessionManager } from "./process-sessions.js";
import type { AppToolRegistrar } from "./session-monitor-integration.js";
import { SoftPauseController } from "./soft-pause.js";
import type { SerenaSemanticManager } from "./serena-semantic.js";
import type { WorkspaceRegistry } from "./workspaces.js";
import {
  createSoftPauseToolRegistrar,
  logToolCall,
  processLogOutcome,
  registerWorkbridgeExtensionTools,
  workbridgeServerInstructions,
} from "./workbridge-tool-registration.js";
import {
  WORKBRIDGE_DISABLED_CAPABILITIES,
  WORKBRIDGE_EXTENSION_TOOL_NAMES,
  WORKBRIDGE_REVIEW_TOOL_NAME,
  WORKBRIDGE_SUBAGENTS_ENABLED,
  WORKBRIDGE_UPSTREAM_TOOL_MODE,
  WORKBRIDGE_WIDGET_MODE,
} from "./workbridge-tool-policy.js";

assert.deepEqual(WORKBRIDGE_EXTENSION_TOOL_NAMES, [
  "run_workspace_action",
  "check_ao_credential_status",
  "run_semantic_action",
  "run_graft_action",
  "run_codebase_memory_action",
]);
assert.equal(WORKBRIDGE_UPSTREAM_TOOL_MODE, "codex");
assert.equal(WORKBRIDGE_WIDGET_MODE, "off");
assert.equal(WORKBRIDGE_REVIEW_TOOL_NAME, "show_changes");
assert.equal(WORKBRIDGE_SUBAGENTS_ENABLED, false);
assert.deepEqual(WORKBRIDGE_DISABLED_CAPABILITIES, [
  "runtime-profile-switching",
  "subagents",
]);
assert.doesNotMatch(workbridgeServerInstructions(), /review card/i);
assert.match(workbridgeServerInstructions(), /combined change review/i);

const registeredNames: string[] = [];
const registrar = ((_server: unknown, name: string, definition: { description?: string }) => {
  registeredNames.push(name);
  return undefined;
}) as unknown as AppToolRegistrar;

registerWorkbridgeExtensionTools({
  server: {} as McpServer,
  config: {
    toolMode: "codex",
  } as ServerConfig,
  workspaces: {} as WorkspaceRegistry,
  processSessions: {} as ProcessSessionManager,
  semanticManager: {} as SerenaSemanticManager,
  codebaseMemoryManager: {} as CodebaseMemoryManager,
  incomingArtifactAdapters: [],
  registerTool: registrar,
  artifactRegisterTool: registrar,
  shellToolMeta: { _meta: {} },
});

assert.deepEqual(registeredNames, [
  "run_workspace_action",
  "check_ao_credential_status",
  "run_semantic_action",
  "run_graft_action",
  "run_codebase_memory_action",
  "download_artifact",
]);
assert.match(workbridgeServerInstructions(), /run_semantic_action/);
assert.match(workbridgeServerInstructions(), /run_graft_action/);
assert.match(workbridgeServerInstructions(), /run_codebase_memory_action/);

assert.deepEqual(processLogOutcome({
  output: "",
  outputTruncated: false,
  running: true,
  wallTimeMs: 10,
}), {
  success: true,
  running: true,
  exitCode: undefined,
  signal: undefined,
});
assert.deepEqual(processLogOutcome({
  output: "failed",
  outputTruncated: false,
  running: false,
  exitCode: 7,
  wallTimeMs: 10,
}), {
  success: false,
  running: false,
  exitCode: 7,
  signal: undefined,
});

const stateDir = await mkdtemp(join(tmpdir(), "workbridge-tool-registration-test-"));
try {
  const logPath = join(stateDir, "logs", "devspace.jsonl");
  const logging = {
    level: "info",
    format: "json",
    file: true,
    filePath: logPath,
    fileMaxFiles: 1,
    requests: true,
    assets: false,
    toolCalls: true,
    shellCommands: false,
    trustProxy: false,
  } as const;
  const loggingConfig = { logging } as ServerConfig;
  const originalConsoleLog = console.log;
  console.log = () => undefined;
  try {
    logToolCall(loggingConfig, {
      tool: "exec_command",
      workspaceId: "ws_usage_test",
      command: "npx -y @nanonets/graft@0.10.1 --dir C:\\tmp\\graph map . --json",
      commandLength: 64,
      success: true,
      durationMs: 123,
    });
    logToolCall(loggingConfig, {
      tool: "run_semantic_action",
      workspaceId: "ws_usage_test",
      action: "find_referencing_symbols",
      success: true,
      durationMs: 45,
    });
    logToolCall(loggingConfig, {
      tool: "run_graft_action",
      workspaceId: "ws_usage_test",
      action: "callers",
      success: true,
      durationMs: 31,
    });
    logToolCall(loggingConfig, {
      tool: "run_codebase_memory_action",
      workspaceId: "ws_usage_test",
      action: "impact",
      success: true,
      durationMs: 27,
    });
    logToolCall(loggingConfig, {
      tool: "write_stdin",
      workspaceId: "ws_usage_test",
      success: true,
      durationMs: 2,
    });
  } finally {
    console.log = originalConsoleLog;
  }
  const usageLines = (await readFile(join(stateDir, "logs", "devspace-tool-usage.jsonl"), "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  assert.equal(usageLines.length, 4);
  assert.deepEqual(
    {
      schemaVersion: usageLines[0]?.schemaVersion,
      tool: usageLines[0]?.tool,
      workspaceId: usageLines[0]?.workspaceId,
      success: usageLines[0]?.success,
      durationMs: usageLines[0]?.durationMs,
      commandKind: usageLines[0]?.commandKind,
      commandAction: usageLines[0]?.commandAction,
    },
    {
      schemaVersion: 1,
      tool: "exec_command",
      workspaceId: "ws_usage_test",
      success: true,
      durationMs: 123,
      commandKind: "graft",
      commandAction: "map",
    },
  );
  assert.equal("command" in (usageLines[0] ?? {}), false);
  assert.equal("commandPreview" in (usageLines[0] ?? {}), false);
  assert.equal("path" in (usageLines[0] ?? {}), false);
  assert.equal(usageLines[1]?.tool, "run_semantic_action");
  assert.equal(usageLines[1]?.action, "find_referencing_symbols");
  assert.equal(usageLines[2]?.tool, "run_graft_action");
  assert.equal(usageLines[2]?.action, "callers");
  assert.equal(usageLines[3]?.tool, "run_codebase_memory_action");
  assert.equal(usageLines[3]?.action, "impact");

  let decoratedDescription = "";
  let capturedHandler: (() => Promise<unknown>) | undefined;
  const baseRegistrar = ((_server: unknown, _name: string, definition: { description?: string }, handler: () => Promise<unknown>) => {
    decoratedDescription = definition.description ?? "";
    capturedHandler = handler;
    return undefined;
  }) as unknown as AppToolRegistrar;
  const softPauseRegistrar = createSoftPauseToolRegistrar(
    new SoftPauseController(stateDir),
    baseRegistrar,
  );
  softPauseRegistrar(
    {} as never,
    "read",
    { description: "Read a file." } as never,
    async () => ({ structuredContent: { result: "ok" } }) as never,
  );
  assert.match(decoratedDescription, /Read a file\./);
  assert.match(decoratedDescription, /WORKBRIDGE_SOFT_PAUSE_REQUESTED/);
  assert.ok(capturedHandler);
  assert.deepEqual(await capturedHandler(), { structuredContent: { result: "ok" } });
} finally {
  await rm(stateDir, { recursive: true, force: true });
}

console.log("workbridge tool registration tests passed");
