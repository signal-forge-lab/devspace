import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ServerConfig } from "./config.js";
import type { ProcessSessionManager } from "./process-sessions.js";
import type { AppToolRegistrar } from "./session-monitor-integration.js";
import { SoftPauseController } from "./soft-pause.js";
import type { WorkspaceRegistry } from "./workspaces.js";
import {
  WORKBRIDGE_FIXED_PUBLIC_TOOL_NAMES,
  createSoftPauseToolRegistrar,
  registerWorkbridgeExtensionTools,
} from "./workbridge-tool-registration.js";

assert.deepEqual(WORKBRIDGE_FIXED_PUBLIC_TOOL_NAMES, [
  "open_workspace",
  "read",
  "apply_patch",
  "exec_command",
  "write_stdin",
  "run_workspace_action",
  "download_artifact",
]);

const registeredNames: string[] = [];
const registrar = ((_server: unknown, name: string) => {
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
  incomingArtifactAdapters: [],
  registerTool: registrar,
  artifactRegisterTool: registrar,
  shellToolMeta: { _meta: {} },
});

assert.deepEqual(registeredNames, [
  "exec_command",
  "write_stdin",
  "run_workspace_action",
  "download_artifact",
]);

const stateDir = await mkdtemp(join(tmpdir(), "workbridge-tool-registration-test-"));
try {
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
