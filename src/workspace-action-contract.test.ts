import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
const artifactProjectRoot = join(temporaryRoot, "artifact-project");
await mkdir(join(artifactProjectRoot, "dist"), { recursive: true });
const embeddedZipBytes = Buffer.from([
  0x50, 0x4b, 0x05, 0x06,
  0x00, 0x00, 0x00, 0x00,
  0x00, 0x00, 0x00, 0x00,
  0x00, 0x00, 0x00, 0x00,
  0x00, 0x00, 0x00, 0x00,
  0x00, 0x00,
]);
await writeFile(join(artifactProjectRoot, "dist", "artifact.zip"), embeddedZipBytes);
const aoProjectRoot = join(temporaryRoot, "ao-python-project");
const aoInputRoot = join(temporaryRoot, "ao-inputs");
await mkdir(join(aoProjectRoot, "tradingagents"), { recursive: true });
await mkdir(aoInputRoot, { recursive: true });
await writeFile(
  join(aoProjectRoot, "tradingagents", "ao_d60_registered_run.py"),
  [
    "import sys",
    "if '--help' in sys.argv:",
    "    print('AO_REGISTERED_HELP_OK')",
    "    raise SystemExit(0)",
    "raise SystemExit(9)",
    "",
  ].join("\n"),
);
const aoInputPaths = {
  bindingPath: join(aoInputRoot, "binding.json"),
  registrationPath: join(aoInputRoot, "registration.json"),
  d60TaskPath: join(aoInputRoot, "d60.md"),
  d61TaskPath: join(aoInputRoot, "d61.md"),
  d62TaskPath: join(aoInputRoot, "d62.md"),
  d63TaskPath: join(aoInputRoot, "d63.md"),
  pricingSnapshotPath: join(aoInputRoot, "pricing.json"),
};
for (const path of Object.values(aoInputPaths)) {
  await writeFile(path, "fixture\n");
}
const aoExecuteParameters = {
  windowOpenUtc: "2026-09-01T20:15:00Z",
  windowCloseUtc: "2026-09-02T12:00:00Z",
  ...aoInputPaths,
  outputPath: join(aoProjectRoot, "local_runs", "future-registration", "d60"),
};
const aegisProjectRoot = join(temporaryRoot, "aegis-project");
const aegisMarkerPath = join(aegisProjectRoot, "detached-marker.txt");
await mkdir(aegisProjectRoot, { recursive: true });
await writeFile(
  join(aegisProjectRoot, "aegis_runner.py"),
  [
    "from pathlib import Path",
    "import sys",
    "if sys.argv[1:] != ['run', '--confirm-post']:",
    "    raise SystemExit(9)",
    "Path('detached-marker.txt').write_text('ok', encoding='utf-8')",
    "",
  ].join("\n"),
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
  () => [],
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

  const openedAegis = await client.callTool({
    name: "open_workspace",
    arguments: { path: aegisProjectRoot },
  });
  const aegisWorkspaceId = requiredString(structured(openedAegis), "workspaceId");
  const aegisLaunch = structured(await client.callTool({
    name: "run_workspace_action",
    arguments: {
      workspaceId: aegisWorkspaceId,
      action: "aegis_runner",
      preset: "run_confirm_post",
    },
  }));
  assert.equal(aegisLaunch.status, "completed");
  assert.equal(aegisLaunch.executed, true);
  assert.equal(aegisLaunch.running, false);
  assert.equal(aegisLaunch.sessionId, undefined);
  assert.deepEqual(
    (aegisLaunch.steps as Array<Record<string, unknown>>).map((step) => step.status),
    ["completed"],
  );
  assert.match(requiredString(aegisLaunch, "result"), /Detached Aegis Runner launched/);
  await waitForFile(aegisMarkerPath);
  await access(aegisMarkerPath);

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
  assert.equal(requiredString(dryRun, "commandPreview"), "npm run verify:rebase && git status --short");
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
  assert.equal(
    requiredString(projectDryRun, "commandPreview"),
    "npm run verify:rebase && git status --short",
  );
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
    [
      "workspace_verify",
      "workspace_review",
      "project_verify",
      "test_changed",
      "project_report",
      "ao_registered_python",
      "publish_artifact",
      "aegis_runner",
    ],
  );

  for (const retiredAction of ["encoded_input_probe", "progress_probe"]) {
    const retired = structured(await client.callTool({
      name: "run_workspace_action",
      arguments: {
        workspaceId,
        action: retiredAction,
      },
    }));
    assert.equal(retired.status, "rejected");
    assert.equal(retired.executed, false);
    assert.equal(record(retired.error).code, "unsupported_action");
  }

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

  const aoOpened = await client.callTool({
    name: "open_workspace",
    arguments: { path: aoProjectRoot },
  });
  const aoWorkspaceId = requiredString(structured(aoOpened), "workspaceId");
  const aoHelpDryRun = structured(await client.callTool({
    name: "run_workspace_action",
    arguments: {
      workspaceId: aoWorkspaceId,
      action: "ao_registered_python",
      preset: "help",
      dryRun: true,
    },
  }));
  assert.equal(aoHelpDryRun.status, "dry_run");
  assert.equal(aoHelpDryRun.action, "ao_registered_python");
  assert.equal(aoHelpDryRun.preset, "help");
  assert.equal(aoHelpDryRun.profile, "python");
  assert.deepEqual(aoHelpDryRun.policy, ["read_only"]);
  assert.match(requiredString(aoHelpDryRun, "commandPreview"), /tradingagents\.ao_d60_registered_run --help/);
  assert.equal(aoHelpDryRun.executed, false);

  const aoHelpCompleted = structured(await client.callTool({
    name: "run_workspace_action",
    arguments: {
      workspaceId: aoWorkspaceId,
      action: "ao_registered_python",
      preset: "help",
      yieldTimeMs: 30_000,
    },
  }));
  assert.equal(aoHelpCompleted.status, "completed");
  assert.equal(aoHelpCompleted.executed, true);
  assert.equal(aoHelpCompleted.running, false);
  assert.deepEqual(
    (aoHelpCompleted.steps as Array<Record<string, unknown>>).map((step) => step.status),
    ["completed"],
  );
  assert.match(requiredString(aoHelpCompleted, "result"), /AO_REGISTERED_HELP_OK/);

  const aoExecuteDryRun = structured(await client.callTool({
    name: "run_workspace_action",
    arguments: {
      workspaceId: aoWorkspaceId,
      action: "ao_registered_python",
      preset: "execute",
      parameters: aoExecuteParameters,
      dryRun: true,
    },
  }));
  assert.equal(aoExecuteDryRun.status, "dry_run");
  assert.equal(aoExecuteDryRun.executed, false);
  assert.deepEqual(
    aoExecuteDryRun.policy,
    ["workspace_modify", "external_effect", "long_running"],
  );
  assert.match(requiredString(aoExecuteDryRun, "commandPreview"), /--execute-registered/);
  assert.match(requiredString(aoExecuteDryRun, "commandPreview"), /2026-09-01T20:15:00Z/);
  assert.equal((aoExecuteDryRun.artifacts as Array<Record<string, unknown>>).length, 1);

  const aoInjectionRejected = structured(await client.callTool({
    name: "run_workspace_action",
    arguments: {
      workspaceId: aoWorkspaceId,
      action: "ao_registered_python",
      preset: "execute",
      parameters: { ...aoExecuteParameters, arguments: ["--help", "&", "calc.exe"] },
      dryRun: true,
    },
  }));
  assert.equal(aoInjectionRejected.status, "rejected");
  assert.equal(aoInjectionRejected.executed, false);
  assert.equal(record(aoInjectionRejected.error).code, "invalid_parameters");
  assert.match(requiredString(record(aoInjectionRejected), "result"), /unsupported parameters: arguments/);

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

  const artifactOpened = await client.callTool({
    name: "open_workspace",
    arguments: { path: artifactProjectRoot },
  });
  const artifactWorkspaceId = requiredString(structured(artifactOpened), "workspaceId");
  const artifactDryRun = structured(await client.callTool({
    name: "run_workspace_action",
    arguments: {
      workspaceId: artifactWorkspaceId,
      action: "publish_artifact",
      parameters: { path: "dist/artifact.zip" },
      dryRun: true,
    },
  }));
  assert.equal(artifactDryRun.status, "dry_run");
  assert.equal(artifactDryRun.executed, false);
  assert.deepEqual(artifactDryRun.policy, ["read_only", "external_effect"]);
  assert.deepEqual(artifactDryRun.steps, []);

  const artifactCall = await client.callTool({
    name: "run_workspace_action",
    arguments: {
      workspaceId: artifactWorkspaceId,
      action: "publish_artifact",
      parameters: { path: "dist/artifact.zip" },
    },
  });
  const artifactResult = structured(artifactCall);
  assert.equal(artifactResult.status, "completed");
  assert.equal(artifactResult.executed, true);
  assert.equal(artifactResult.running, false);
  const artifactContent = record(artifactCall).content as Array<Record<string, unknown>>;
  const resource = artifactContent.find((entry) => entry.type === "resource");
  assert.ok(resource);
  const resourceBody = record(resource.resource);
  assert.equal(resourceBody.mimeType, "application/zip");
  assert.match(requiredString(resourceBody, "uri"), /^workbridge:\/\/published-artifact\//);
  assert.deepEqual(
    Buffer.from(requiredString(resourceBody, "blob"), "base64"),
    embeddedZipBytes,
  );
} finally {
  await client.close().catch(() => undefined);
  await server.close().catch(() => undefined);
  processSessions.shutdown();
  workspaceStore.close?.();
  await rm(temporaryRoot, { recursive: true, force: true });
}

async function waitForFile(path: string): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      await access(path);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  throw new Error(`Timed out waiting for detached action marker: ${path}`);
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
