import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { loadConfig } from "./config.js";
import { ProcessSessionManager } from "./process-sessions.js";
import { createReviewCheckpointManager } from "./review-checkpoints.js";
import { createMcpServer } from "./server.js";
import { createWorkspaceStore } from "./workspace-store.js";
import { WorkspaceRegistry } from "./workspaces.js";

const temporaryRoot = await mkdtemp(join(tmpdir(), "workbridge-action-working-directory-test-"));
const workspaceRoot = join(temporaryRoot, "workspace");
const frontendRoot = join(workspaceRoot, "frontend");
await mkdir(frontendRoot, { recursive: true });
await writeFile(
  join(workspaceRoot, "pyproject.toml"),
  "[project]\nname = \"root-python\"\n",
);
await writeFile(
  join(frontendRoot, "package.json"),
  JSON.stringify({ scripts: { typecheck: "tsc --noEmit" } }),
);

const stateDir = join(temporaryRoot, "state");
const workspaceStore = createWorkspaceStore(stateDir);
const processSessions = new ProcessSessionManager();
const config = loadConfig({
  DEVSPACE_CONFIG_DIR: join(temporaryRoot, "config"),
  DEVSPACE_STATE_DIR: stateDir,
  DEVSPACE_ALLOWED_ROOTS: workspaceRoot,
  DEVSPACE_OAUTH_OWNER_TOKEN: "workbridge-working-directory-owner-token",
});
const server = createMcpServer(
  config,
  new WorkspaceRegistry(config, workspaceStore),
  createReviewCheckpointManager(),
  processSessions,
  () => [],
  [],
);
const client = new Client(
  { name: "workbridge-action-working-directory-test", version: "1.0.0" },
  { capabilities: {} },
);
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

try {
  await server.connect(serverTransport);
  await client.connect(clientTransport);

  const opened = structured(await client.callTool({
    name: "open_workspace",
    arguments: { path: workspaceRoot },
  }));
  const workspaceId = requiredString(opened, "workspaceId");

  const nestedProject = structured(await client.callTool({
    name: "run_workspace_action",
    arguments: {
      workspaceId,
      action: "project_verify",
      workingDirectory: "frontend",
      dryRun: true,
    },
  }));
  assert.equal(nestedProject.status, "dry_run");
  assert.equal(nestedProject.profile, "node");
  assert.match(requiredString(nestedProject, "commandPreview"), /npm run typecheck/);

  const rootProject = structured(await client.callTool({
    name: "run_workspace_action",
    arguments: {
      workspaceId,
      action: "project_verify",
      dryRun: true,
    },
  }));
  assert.equal(rootProject.profile, "python");

  const nestedCompatibilityAction = structured(await client.callTool({
    name: "run_workspace_action",
    arguments: {
      workspaceId,
      action: "workspace_verify",
      workingDirectory: "frontend",
      dryRun: true,
    },
  }));
  assert.equal(nestedCompatibilityAction.status, "rejected");
  assert.equal(record(nestedCompatibilityAction.error).code, "invalid_working_directory");
  assert.match(
    requiredString(record(nestedCompatibilityAction.error), "message"),
    /restricted to the workspace root/,
  );

  const outsidePath = join(temporaryRoot, "outside-workspace");
  const rejectedOutside = await client.callTool({
    name: "run_workspace_action",
    arguments: {
      workspaceId,
      action: "project_verify",
      workingDirectory: "../outside-workspace",
      dryRun: true,
    },
  });
  const rejectedOutsideStructured = structured(rejectedOutside);
  assert.equal(rejectedOutsideStructured.status, "rejected");
  assert.equal(record(rejectedOutsideStructured.error).code, "invalid_working_directory");
  assert.doesNotMatch(JSON.stringify(rejectedOutside), new RegExp(escapeRegex(outsidePath), "i"));
  assert.match(JSON.stringify(rejectedOutside), /<workingDirectory>/);
} finally {
  await client.close().catch(() => undefined);
  await server.close().catch(() => undefined);
  processSessions.shutdown();
  workspaceStore.close?.();
  await rm(temporaryRoot, { recursive: true, force: true });
}

function structured(value: unknown): Record<string, unknown> {
  return record(record(value).structuredContent);
}

function record(value: unknown): Record<string, unknown> {
  assert.ok(value && typeof value === "object" && !Array.isArray(value));
  return value as Record<string, unknown>;
}

function requiredString(value: Record<string, unknown>, field: string): string {
  const candidate = value[field];
  assert.equal(typeof candidate, "string");
  return candidate as string;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
