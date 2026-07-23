import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
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

const temporaryRoot = await mkdtemp(join(tmpdir(), "workbridge-action-contract-test-"));
const stateDir = join(temporaryRoot, "state");
const workspaceStore = createWorkspaceStore(stateDir);
const processSessions = new ProcessSessionManager();
const config = loadConfig({
  DEVSPACE_CONFIG_DIR: join(temporaryRoot, "config"),
  DEVSPACE_STATE_DIR: stateDir,
  DEVSPACE_ALLOWED_ROOTS: process.cwd(),
  DEVSPACE_OAUTH_OWNER_TOKEN: "workbridge-action-contract-owner-token",
});
const server = createMcpServer(
  config,
  new WorkspaceRegistry(config, workspaceStore),
  createReviewCheckpointManager(),
  processSessions,
  [],
  [],
);
const client = new Client(
  { name: "workbridge-action-contract-test", version: "1.0.0" },
  { capabilities: {} },
);
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

try {
  await server.connect(serverTransport);
  await client.connect(clientTransport);

  const opened = await client.callTool({
    name: "open_workspace",
    arguments: { path: process.cwd() },
  });
  const workspaceId = requiredString(structured(opened), "workspaceId");

  const dryRun = structured(await client.callTool({
    name: "run_workspace_action",
    arguments: {
      workspaceId,
      action: "workspace_verify",
      preset: "standard",
      dryRun: true,
    },
  }));
  assert.equal(dryRun.contractVersion, 1);
  assert.equal(dryRun.status, "dry_run");
  assert.equal(dryRun.action, "workspace_verify");
  assert.equal(dryRun.preset, "standard");
  assert.equal(dryRun.executed, false);
  assert.equal(dryRun.running, false);
  assert.deepEqual(dryRun.policy, ["workspace_modify", "long_running"]);
  assert.match(requiredString(dryRun, "commandPreview"), /npm run typecheck/);

  const reviewDryRun = structured(await client.callTool({
    name: "run_workspace_action",
    arguments: {
      workspaceId,
      action: "workspace_review",
      dryRun: true,
    },
  }));
  assert.equal(reviewDryRun.contractVersion, 1);
  assert.equal(reviewDryRun.status, "dry_run");
  assert.equal(reviewDryRun.action, "workspace_review");
  assert.equal(reviewDryRun.preset, "summary");
  assert.equal(reviewDryRun.executed, false);
  assert.deepEqual(reviewDryRun.policy, ["read_only"]);
  assert.match(requiredString(reviewDryRun, "commandPreview"), /git status --short/);

  const projectDryRun = structured(await client.callTool({
    name: "run_workspace_action",
    arguments: {
      workspaceId,
      action: "project_verify",
      dryRun: true,
    },
  }));
  assert.equal(projectDryRun.contractVersion, 1);
  assert.equal(projectDryRun.status, "dry_run");
  assert.equal(projectDryRun.action, "project_verify");
  assert.equal(projectDryRun.profile, "workbridge");
  assert.equal(projectDryRun.executed, false);
  assert.match(requiredString(projectDryRun, "commandPreview"), /npm run baseline:tools:check/);

  const rejected = structured(await client.callTool({
    name: "run_workspace_action",
    arguments: {
      workspaceId,
      action: "unknown_action",
    },
  }));
  assert.equal(rejected.contractVersion, 1);
  assert.equal(rejected.status, "rejected");
  assert.equal(rejected.action, "unknown_action");
  assert.equal(rejected.executed, false);
  assert.equal(rejected.running, false);
  assert.deepEqual(rejected.policy, []);
  assert.equal(record(rejected.error).code, "unsupported_action");
  assert.deepEqual(
    (rejected.catalog as Array<Record<string, unknown>>).map((entry) => entry.action),
    ["workspace_verify", "workspace_review", "project_verify", "test_changed"],
  );

  const invalidWorkingDirectory = structured(await client.callTool({
    name: "run_workspace_action",
    arguments: {
      workspaceId,
      action: "workspace_verify",
      workingDirectory: "../outside-workspace",
    },
  }));
  assert.equal(invalidWorkingDirectory.contractVersion, 1);
  assert.equal(invalidWorkingDirectory.status, "rejected");
  assert.equal(invalidWorkingDirectory.executed, false);
  assert.equal(record(invalidWorkingDirectory.error).code, "invalid_working_directory");
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
