import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
const failingProjectRoot = join(temporaryRoot, "failing-node-project");
await mkdir(failingProjectRoot, { recursive: true });
await writeFile(
  join(failingProjectRoot, "package.json"),
  JSON.stringify({
    scripts: {
      test: "node -e \"process.exit(7)\"",
      build: "node -e \"console.log('should-not-build')\"",
    },
  }),
);
const reportProjectRoot = join(temporaryRoot, "report-node-project");
await mkdir(reportProjectRoot, { recursive: true });
await writeFile(
  join(reportProjectRoot, "package.json"),
  JSON.stringify({ scripts: { test: "node --test" } }),
);
const stateDir = join(temporaryRoot, "state");
const workspaceStore = createWorkspaceStore(stateDir);
const processSessions = new ProcessSessionManager();
const config = loadConfig({
  DEVSPACE_CONFIG_DIR: join(temporaryRoot, "config"),
  DEVSPACE_STATE_DIR: stateDir,
  DEVSPACE_ALLOWED_ROOTS: `${process.cwd()},${temporaryRoot}`,
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
  assert.equal(dryRun.contractVersion, 2);
  assert.equal(dryRun.status, "dry_run");
  assert.equal(dryRun.action, "workspace_verify");
  assert.equal(dryRun.preset, "standard");
  assert.equal(dryRun.executed, false);
  assert.equal(dryRun.running, false);
  assert.deepEqual(dryRun.policy, ["workspace_modify", "long_running"]);
  assert.match(requiredString(dryRun, "commandPreview"), /npm run typecheck/);
  assert.ok((dryRun.steps as Array<Record<string, unknown>>).every((step) => step.status === "pending"));
  assert.ok((dryRun.profileEvidence as unknown[]).length > 0);
  assert.deepEqual(dryRun.artifacts, []);
  assert.ok((dryRun.warnings as string[]).some((warning) => /compatibility alias/.test(warning)));

  const reviewDryRun = structured(await client.callTool({
    name: "run_workspace_action",
    arguments: {
      workspaceId,
      action: "workspace_review",
      dryRun: true,
    },
  }));
  assert.equal(reviewDryRun.contractVersion, 2);
  assert.equal(reviewDryRun.status, "dry_run");
  assert.equal(reviewDryRun.action, "workspace_review");
  assert.equal(reviewDryRun.preset, "summary");
  assert.equal(reviewDryRun.executed, false);
  assert.deepEqual(reviewDryRun.policy, ["read_only"]);
  assert.match(requiredString(reviewDryRun, "commandPreview"), /git status --short/);
  assert.deepEqual(reviewDryRun.profileEvidence, []);
  assert.deepEqual(reviewDryRun.warnings, []);
  assert.equal((reviewDryRun.steps as unknown[]).length, 3);

  const reviewCompleted = structured(await client.callTool({
    name: "run_workspace_action",
    arguments: {
      workspaceId,
      action: "workspace_review",
      preset: "summary",
      yieldTimeMs: 30_000,
    },
  }));
  assert.equal(reviewCompleted.contractVersion, 2);
  assert.equal(reviewCompleted.status, "completed");
  assert.equal(reviewCompleted.executed, true);
  assert.equal(reviewCompleted.running, false);
  assert.deepEqual(
    (reviewCompleted.steps as Array<Record<string, unknown>>).map((step) => step.status),
    ["completed", "completed", "completed"],
  );
  assert.ok(
    (reviewCompleted.steps as Array<Record<string, unknown>>)
      .every((step) => typeof step.durationMs === "number"),
  );

  const projectDryRun = structured(await client.callTool({
    name: "run_workspace_action",
    arguments: {
      workspaceId,
      action: "project_verify",
      dryRun: true,
    },
  }));
  assert.equal(projectDryRun.contractVersion, 2);
  assert.equal(projectDryRun.status, "dry_run");
  assert.equal(projectDryRun.action, "project_verify");
  assert.equal(projectDryRun.profile, "workbridge");
  assert.equal(projectDryRun.executed, false);
  assert.match(requiredString(projectDryRun, "commandPreview"), /npm run baseline:tools:check/);
  assert.ok((projectDryRun.profileEvidence as unknown[]).length > 0);

  const rejected = structured(await client.callTool({
    name: "run_workspace_action",
    arguments: {
      workspaceId,
      action: "unknown_action",
    },
  }));
  assert.equal(rejected.contractVersion, 2);
  assert.equal(rejected.status, "rejected");
  assert.equal(rejected.action, "unknown_action");
  assert.equal(rejected.executed, false);
  assert.equal(rejected.running, false);
  assert.deepEqual(rejected.policy, []);
  assert.deepEqual(rejected.steps, []);
  assert.deepEqual(rejected.profileEvidence, []);
  assert.deepEqual(rejected.warnings, []);
  assert.deepEqual(rejected.artifacts, []);
  assert.equal(record(rejected.error).code, "unsupported_action");
  assert.deepEqual(
    (rejected.catalog as Array<Record<string, unknown>>).map((entry) => entry.action),
    ["workspace_verify", "workspace_review", "project_verify", "test_changed", "project_report"],
  );

  const invalidWorkingDirectory = structured(await client.callTool({
    name: "run_workspace_action",
    arguments: {
      workspaceId,
      action: "workspace_verify",
      workingDirectory: "../outside-workspace",
    },
  }));
  assert.equal(invalidWorkingDirectory.contractVersion, 2);
  assert.equal(invalidWorkingDirectory.status, "rejected");
  assert.equal(invalidWorkingDirectory.executed, false);
  assert.equal(record(invalidWorkingDirectory.error).code, "invalid_working_directory");
  assert.ok((invalidWorkingDirectory.steps as Array<Record<string, unknown>>)
    .every((step) => step.status === "pending"));

  const failingOpened = await client.callTool({
    name: "open_workspace",
    arguments: { path: failingProjectRoot },
  });
  const failingWorkspaceId = requiredString(structured(failingOpened), "workspaceId");
  const failed = structured(await client.callTool({
    name: "run_workspace_action",
    arguments: {
      workspaceId: failingWorkspaceId,
      action: "project_verify",
      preset: "standard",
      yieldTimeMs: 30_000,
    },
  }));
  assert.equal(failed.contractVersion, 2);
  assert.equal(failed.status, "failed");
  assert.equal(failed.executed, true);
  assert.equal(failed.running, false);
  assert.equal(record(failed.error).code, "step_failed");
  assert.deepEqual(
    (failed.steps as Array<Record<string, unknown>>).map((step) => step.status),
    ["failed", "skipped"],
  );
  assert.equal((failed.steps as Array<Record<string, unknown>>)[0]?.exitCode, 7);

  const reportOpened = await client.callTool({
    name: "open_workspace",
    arguments: { path: reportProjectRoot },
  });
  const reportWorkspaceId = requiredString(structured(reportOpened), "workspaceId");
  const reportResult = structured(await client.callTool({
    name: "run_workspace_action",
    arguments: {
      workspaceId: reportWorkspaceId,
      action: "project_report",
      yieldTimeMs: 30_000,
    },
  }));
  assert.equal(reportResult.status, "completed");
  assert.equal(reportResult.profile, "node");
  const reportArtifacts = reportResult.artifacts as Array<Record<string, unknown>>;
  assert.equal(reportArtifacts.length, 1);
  const reportPath = requiredString(reportArtifacts[0] ?? {}, "path");
  const report = JSON.parse(await readFile(join(reportProjectRoot, reportPath), "utf8")) as {
    profile?: unknown;
    reportType?: unknown;
  };
  assert.equal(report.profile, "node");
  assert.equal(report.reportType, "workbridge_project_profile");
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
