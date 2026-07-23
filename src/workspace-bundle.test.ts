import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { inflateRawSync } from "node:zlib";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import express from "express";
import { loadConfig } from "./config.js";
import { ProcessSessionManager } from "./process-sessions.js";
import { createReviewCheckpointManager } from "./review-checkpoints.js";
import { createMcpServer } from "./server.js";
import { createWorkspaceStore } from "./workspace-store.js";
import {
  WorkspaceBundleStore,
  createWorkspaceBundleEmbeddedTransferProbe,
  redactWorkspaceBundleRequestPath,
} from "./workspace-bundle.js";
import { registerWorkspaceBundleDownloadRoutes } from "./workspace-bundle-registration.js";
import { WorkspaceRegistry, type Workspace } from "./workspaces.js";

const execFileAsync = promisify(execFile);
const temporaryRoot = await mkdtemp(join(tmpdir(), "workbridge-workspace-bundle-test-"));
const projectRoot = join(temporaryRoot, "project");
const stateDir = join(temporaryRoot, "state");
const externalSkillsRoot = join(temporaryRoot, "external-skills");
await mkdir(join(projectRoot, "src"), { recursive: true });
await writeFile(join(projectRoot, "src", "index.ts"), "export const value = 1;\n", "utf8");
await writeFile(join(projectRoot, "src", "token-utils.ts"), "export const tokenize = String;\n", "utf8");
await writeFile(join(projectRoot, ".env"), "SECRET=not-exported\n", "utf8");
await writeFile(join(projectRoot, ".env.example"), "SECRET=replace-me\n", "utf8");
await writeFile(join(projectRoot, "credentials.json"), "{\"token\":\"not-exported\"}\n", "utf8");
await writeFile(join(projectRoot, ".gitignore"), "node_modules/\n", "utf8");
await writeFile(
  join(projectRoot, "package.json"),
  JSON.stringify({
    scripts: {
      typecheck: "node -e \"setTimeout(() => process.exit(0), 150)\"",
      "baseline:tools:check": "node -e \"process.exit(0)\"",
      test: "node -e \"process.exit(0)\"",
      build: "node -e \"process.exit(0)\"",
    },
  }),
  "utf8",
);
await mkdir(join(externalSkillsRoot, "bundle-test-skill"), { recursive: true });
await writeFile(
  join(externalSkillsRoot, "bundle-test-skill", "SKILL.md"),
  [
    "---",
    "name: bundle-test-skill",
    "description: External instruction for sandbox bundle exception-read tests.",
    "---",
    "",
    "Use the external bundle test instruction.",
  ].join("\n"),
  "utf8",
);
await writeFile(
  join(externalSkillsRoot, "bundle-test-skill", "REFERENCE.md"),
  "External skill attachment that is intentionally unavailable in stage one.\n",
  "utf8",
);
await git(projectRoot, ["init"]);
await git(projectRoot, ["config", "user.name", "Workbridge Test"]);
await git(projectRoot, ["config", "user.email", "workbridge@example.invalid"]);
await git(projectRoot, ["add", "."]);
await git(projectRoot, ["commit", "-m", "initial"]);

await writeFile(join(projectRoot, "src", "index.ts"), "export const value = 2;\n", "utf8");
await writeFile(join(projectRoot, "notes.txt"), "untracked working tree file\n", "utf8");
await mkdir(join(projectRoot, "node_modules"), { recursive: true });
await writeFile(join(projectRoot, "node_modules", "ignored.txt"), "ignored\n", "utf8");
await writeFile(join(projectRoot, "node_modules", "binary.bin"), Buffer.from([0, 1, 2, 3]));

let nowMs = Date.UTC(2026, 6, 20, 3, 4, 5);
const token = "A".repeat(43);
const store = new WorkspaceBundleStore({
  stateDir,
  publicBaseUrl: "https://workbridge.example.test",
  now: () => nowMs,
  randomToken: () => token,
});
const workspace: Workspace = {
  id: "ws_bundle_test",
  root: projectRoot,
  mode: "checkout",
  skills: [],
  skillDiagnostics: [],
  agentProfiles: [],
  activatedSkillDirs: new Set(),
};

try {
  const embeddedProbe = createWorkspaceBundleEmbeddedTransferProbe();
  assert.equal(
    embeddedProbe.resourceUri,
    "workbridge://transfer-probe/workbridge-embedded-resource-probe-v1.zip",
  );
  assert.equal(embeddedProbe.fileName, "workbridge-embedded-resource-probe.zip");
  assert.equal(embeddedProbe.sha256.length, 64);
  const embeddedProbeArchive = Buffer.from(embeddedProbe.blob, "base64");
  assert.equal(embeddedProbeArchive.length, embeddedProbe.sizeBytes);
  assert.equal(
    readZipEntries(embeddedProbeArchive).get("workbridge-embedded-resource-probe.txt")?.toString("utf8"),
    "Workbridge embedded ZIP transfer probe v1.\n",
  );

  const result = await store.exportWorkspace(workspace);
  assert.match(result.bundleId, /^bundle_20260720_030405_[a-f0-9]{10}$/);
  assert.equal(result.fileCount, 6);
  assert.equal(result.downloadUrl, `https://workbridge.example.test/workbridge-bundles/${token}/workspace.zip`);
  assert.equal(result.fileName, `project-${result.bundleId}.zip`);
  assert.equal(
    result.resourceUri,
    `workbridge://workspace-bundle/${result.bundleId}/${result.fileName}`,
  );
  assert.equal(result.excludedFiles.includes(".env"), true);
  assert.equal(result.excludedFiles.includes("credentials.json"), true);
  assert.equal(result.excludedFiles.includes(".env.example"), false);
  assert.deepEqual(
    result.exclusions.find((entry) => entry.path === ".env"),
    { path: ".env", reason: "sensitive_path", exceptionReadable: false },
  );
  assert.equal(result.sha256.length, 64);

  const download = store.peekDownload(token);
  assert.equal(download.remainingDownloads, 2);
  const archive = await readFile(download.filePath);
  assert.deepEqual(Buffer.from(result.blob, "base64"), archive);
  const entries = readZipEntries(archive);
  assert.equal(entries.get("src/index.ts")?.toString("utf8"), "export const value = 2;\n");
  assert.equal(entries.get("src/token-utils.ts")?.toString("utf8"), "export const tokenize = String;\n");
  assert.equal(entries.get("notes.txt")?.toString("utf8"), "untracked working tree file\n");
  assert.equal(entries.get(".env.example")?.toString("utf8"), "SECRET=replace-me\n");
  assert.equal(entries.has(".env"), false);
  assert.equal(entries.has("credentials.json"), false);
  assert.equal(entries.has("node_modules/ignored.txt"), false);

  const manifest = JSON.parse(entries.get(".workbridge-bundle/manifest.json")?.toString("utf8") ?? "null") as {
    formatVersion: number;
    source: { dirty: boolean; gitHead: string; workspaceId: string };
    excludedFiles: string[];
    exclusions: Array<{ path: string; reason: string; exceptionReadable: boolean }>;
    files: Array<{ path: string }>;
  };
  assert.equal(manifest.formatVersion, 2);
  assert.equal(manifest.source.dirty, true);
  assert.equal(manifest.source.gitHead.length, 40);
  assert.equal(manifest.source.workspaceId, workspace.id);
  assert.equal(manifest.excludedFiles.includes(".env"), true);
  assert.deepEqual(
    manifest.exclusions.find((entry) => entry.path === ".env"),
    { path: ".env", reason: "sensitive_path", exceptionReadable: false },
  );
  assert.equal(manifest.files.some((file) => file.path === "notes.txt"), true);

  await writeFile(join(projectRoot, ".env"), "SECRET=changed-after-export\n", "utf8");
  await assert.rejects(
    store.applyPatchFromLatestBundle(workspace, async () => "not-applied"),
    /workspace changed after this bundle was created/i,
  );
  await writeFile(join(projectRoot, ".env"), "SECRET=not-exported\n", "utf8");

  const app = express();
  registerWorkspaceBundleDownloadRoutes(app, store);
  const httpServer = app.listen(0, "127.0.0.1");
  await once(httpServer, "listening");
  const port = (httpServer.address() as AddressInfo).port;
  const localUrl = `http://127.0.0.1:${port}/workbridge-bundles/${token}/workspace.zip`;
  try {
    const headResponse = await fetch(localUrl, { method: "HEAD" });
    assert.equal(headResponse.status, 200);
    assert.equal(headResponse.headers.get("content-type"), "application/zip");
    assert.equal(headResponse.headers.get("cache-control"), "no-store, max-age=0");
    assert.equal(headResponse.headers.get("accept-ranges"), "none");
    assert.equal(store.peekDownload(token).remainingDownloads, 2);

    for (let downloadIndex = 0; downloadIndex < 2; downloadIndex += 1) {
      const response = await fetch(localUrl);
      assert.equal(response.status, 200);
      assert.deepEqual(Buffer.from(await response.arrayBuffer()), archive);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal((await fetch(localUrl)).status, 404);
  } finally {
    httpServer.close();
    await once(httpServer, "close");
  }

  assert.equal(
    redactWorkspaceBundleRequestPath(`/workbridge-bundles/${token}/workspace.zip`),
    "/workbridge-bundles/<token>/workspace.zip",
  );

  const mcpStateDir = join(temporaryRoot, "mcp-state");
  const workspaceStore = createWorkspaceStore(mcpStateDir);
  const processSessions = new ProcessSessionManager();
  const mcpBundleStore = new WorkspaceBundleStore({
    stateDir: mcpStateDir,
    publicBaseUrl: "https://workbridge.example.test",
  });
  const config = loadConfig({
    DEVSPACE_CONFIG_DIR: join(temporaryRoot, "mcp-config"),
    DEVSPACE_STATE_DIR: mcpStateDir,
    DEVSPACE_ALLOWED_ROOTS: projectRoot,
    DEVSPACE_OAUTH_OWNER_TOKEN: "workspace-bundle-mcp-test-owner-token",
    DEVSPACE_TOOL_MODE: "sandbox_bundle",
    DEVSPACE_WIDGETS: "off",
    DEVSPACE_SKILL_PATHS: externalSkillsRoot,
    DEVSPACE_SUBAGENTS: "0",
  });
  const mcpServer = createMcpServer(
    config,
    new WorkspaceRegistry(config, workspaceStore),
    createReviewCheckpointManager(),
    processSessions,
    [],
    [],
    mcpBundleStore,
  );
  const client = new Client({ name: "workspace-bundle-test", version: "1.0.0" }, { capabilities: {} });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await mcpServer.connect(serverTransport);
    await client.connect(clientTransport);
    const toolNames = (await client.listTools()).tools.map((tool) => tool.name).sort();
    assert.deepEqual(toolNames, [
      "apply_patch",
      "export_workspace_bundle",
      "open_workspace",
      "probe_embedded_zip_transfer",
      "read_unbundled_file",
    ]);
    const probeResult = await client.callTool({
      name: "probe_embedded_zip_transfer",
      arguments: {},
    });
    assert.equal(probeResult.isError, undefined);
    const probeStructured = probeResult.structuredContent as {
      resourceUri?: unknown;
      fileName?: unknown;
      sizeBytes?: unknown;
      sha256?: unknown;
    } | undefined;
    assert.equal(probeStructured?.resourceUri, embeddedProbe.resourceUri);
    assert.equal(probeStructured?.fileName, embeddedProbe.fileName);
    assert.equal(probeStructured?.sizeBytes, embeddedProbe.sizeBytes);
    assert.equal(probeStructured?.sha256, embeddedProbe.sha256);
    const probeContent = probeResult.content as Array<{
      type: string;
      resource?: { uri?: string; mimeType?: string; blob?: string };
      annotations?: { audience?: string[]; priority?: number };
    }>;
    const embeddedResource = probeContent.find((entry) => entry.type === "resource");
    assert.equal(embeddedResource?.resource?.uri, embeddedProbe.resourceUri);
    assert.equal(embeddedResource?.resource?.mimeType, "application/zip");
    assert.equal(embeddedResource?.resource?.blob, embeddedProbe.blob);
    assert.deepEqual(embeddedResource?.annotations?.audience, ["assistant", "user"]);
    assert.equal(embeddedResource?.annotations?.priority, 1);

    const openResult = await client.callTool({
      name: "open_workspace",
      arguments: { path: projectRoot },
    });
    const workspaceId = (openResult.structuredContent as { workspaceId?: unknown } | undefined)?.workspaceId;
    assert.equal(typeof workspaceId, "string");
    const externalSkillPath = (
      openResult.structuredContent as { skills?: Array<{ path?: unknown }> } | undefined
    )?.skills?.find((skill) => typeof skill.path === "string")?.path;
    assert.equal(typeof externalSkillPath, "string");
    const exportResult = await client.callTool({
      name: "export_workspace_bundle",
      arguments: { workspaceId },
    });
    assert.equal(exportResult.isError, undefined);
    const bundleId = (exportResult.structuredContent as { bundleId?: unknown } | undefined)?.bundleId;
    assert.equal(typeof bundleId, "string");
    assert.equal(
      Object.hasOwn(exportResult.structuredContent as object, "blob"),
      false,
    );
    assert.match(
      String((exportResult.structuredContent as { downloadUrl?: unknown } | undefined)?.downloadUrl),
      /^https:\/\/workbridge\.example\.test\/workbridge-bundles\//,
    );
    const exportContent = exportResult.content as Array<{
      type: string;
      uri?: string;
      mimeType?: string;
      size?: number;
      resource?: { uri?: string; mimeType?: string; blob?: string };
      annotations?: { audience?: string[]; priority?: number };
    }>;
    const embeddedBundleResource = exportContent.find((entry) => entry.type === "resource");
    assert.equal(embeddedBundleResource?.resource?.mimeType, "application/zip");
    assert.match(
      String(embeddedBundleResource?.resource?.uri),
      /^workbridge:\/\/workspace-bundle\/bundle_[^/]+\/project-bundle_[^/]+\.zip$/,
    );
    const embeddedBundleArchive = Buffer.from(
      String(embeddedBundleResource?.resource?.blob),
      "base64",
    );
    assert.equal(
      embeddedBundleArchive.length,
      (exportResult.structuredContent as { sizeBytes?: unknown } | undefined)?.sizeBytes,
    );
    assert.equal(
      createHash("sha256").update(embeddedBundleArchive).digest("hex"),
      (exportResult.structuredContent as { sha256?: unknown } | undefined)?.sha256,
    );
    assert.deepEqual(embeddedBundleResource?.annotations?.audience, ["assistant", "user"]);
    assert.equal(embeddedBundleResource?.annotations?.priority, 1);
    const bundleResource = exportContent.find((entry) => entry.type === "resource_link");
    assert.equal(bundleResource?.type, "resource_link");
    if (!bundleResource) throw new Error("Expected a workspace bundle resource link.");
    assert.equal(
      bundleResource.uri,
      (exportResult.structuredContent as { downloadUrl?: unknown } | undefined)?.downloadUrl,
    );
    assert.equal(bundleResource.mimeType, "application/zip");
    assert.equal(
      bundleResource.size,
      (exportResult.structuredContent as { sizeBytes?: unknown } | undefined)?.sizeBytes,
    );
    assert.deepEqual(bundleResource.annotations?.audience, ["assistant", "user"]);
    assert.equal(bundleResource.annotations?.priority, 1);

    const ignoredRead = await client.callTool({
      name: "read_unbundled_file",
      arguments: {
        workspaceId,
        bundleId,
        path: "node_modules/ignored.txt",
        reason: "excluded_from_bundle",
        purpose: "Inspect a Git-ignored test fixture absent from the bundle.",
      },
    });
    assert.equal(ignoredRead.isError, undefined);
    assert.match(String((ignoredRead.structuredContent as { result?: unknown })?.result), /ignored/);

    const includedRead = await client.callTool({
      name: "read_unbundled_file",
      arguments: {
        workspaceId,
        bundleId,
        path: "src/index.ts",
        reason: "excluded_from_bundle",
        purpose: "Attempt to bypass the sandbox copy for a bundled source file.",
      },
    });
    assert.equal(includedRead.isError, true);
    assert.match(String((includedRead.structuredContent as { result?: unknown })?.result), /present in the referenced bundle/);

    const sensitiveRead = await client.callTool({
      name: "read_unbundled_file",
      arguments: {
        workspaceId,
        bundleId,
        path: ".env",
        reason: "excluded_from_bundle",
        purpose: "Attempt to read a sensitive file excluded from the bundle.",
      },
    });
    assert.equal(sensitiveRead.isError, true);
    assert.match(String((sensitiveRead.structuredContent as { result?: unknown })?.result), /Sensitive paths/);

    const binaryRead = await client.callTool({
      name: "read_unbundled_file",
      arguments: {
        workspaceId,
        bundleId,
        path: "node_modules/binary.bin",
        reason: "excluded_from_bundle",
        purpose: "Confirm that binary exception reads are rejected by the server.",
      },
    });
    assert.equal(binaryRead.isError, true);
    assert.match(String((binaryRead.structuredContent as { result?: unknown })?.result), /UTF-8 text files only/);

    const externalRead = await client.callTool({
      name: "read_unbundled_file",
      arguments: {
        workspaceId,
        bundleId,
        path: externalSkillPath,
        reason: "external_instruction",
        purpose: "Load the advertised external skill required for this task.",
      },
    });
    assert.equal(externalRead.isError, undefined);
    assert.match(String((externalRead.structuredContent as { result?: unknown })?.result), /external bundle test instruction/i);

    const externalAttachmentRead = await client.callTool({
      name: "read_unbundled_file",
      arguments: {
        workspaceId,
        bundleId,
        path: String(externalSkillPath).replace(/SKILL\.md$/, "REFERENCE.md"),
        reason: "external_instruction",
        purpose: "Attempt to expand the exception path beyond the advertised SKILL file.",
      },
    });
    assert.equal(externalAttachmentRead.isError, true);
    assert.match(
      String((externalAttachmentRead.structuredContent as { result?: unknown })?.result),
      /only valid for an advertised external skill file/,
    );

    await writeFile(join(projectRoot, "src", "index.ts"), "export const value = 3;\n", "utf8");
    const staleBundleRead = await client.callTool({
      name: "read_unbundled_file",
      arguments: {
        workspaceId,
        bundleId,
        path: "node_modules/ignored.txt",
        reason: "excluded_from_bundle",
        purpose: "Confirm that a stale bundle cannot authorize later exception reads.",
      },
    });
    assert.equal(staleBundleRead.isError, true);
    assert.match(String((staleBundleRead.structuredContent as { result?: unknown })?.result), /Export a new bundle/);
  } finally {
    await client.close().catch(() => undefined);
    await mcpServer.close().catch(() => undefined);
    processSessions.shutdown();
    await mcpBundleStore.close();
    workspaceStore.close?.();
  }

  const codexStateDir = join(temporaryRoot, "codex-mcp-state");
  const codexWorkspaceStore = createWorkspaceStore(codexStateDir);
  const codexProcessSessions = new ProcessSessionManager();
  const codexBundleStore = new WorkspaceBundleStore({
    stateDir: codexStateDir,
    publicBaseUrl: "https://workbridge.example.test",
  });
  const codexConfig = loadConfig({
    DEVSPACE_CONFIG_DIR: join(temporaryRoot, "codex-mcp-config"),
    DEVSPACE_STATE_DIR: codexStateDir,
    DEVSPACE_ALLOWED_ROOTS: projectRoot,
    DEVSPACE_OAUTH_OWNER_TOKEN: "workspace-bundle-codex-test-owner-token",
    DEVSPACE_TOOL_MODE: "codex",
    DEVSPACE_WIDGETS: "off",
    DEVSPACE_SKILL_PATHS: externalSkillsRoot,
    WORKBRIDGE_ENABLE_SANDBOX_BUNDLE: "1",
    WORKBRIDGE_SANDBOX_BUNDLE_POLICY: "1",
    DEVSPACE_SUBAGENTS: "0",
  });
  const codexServer = createMcpServer(
    codexConfig,
    new WorkspaceRegistry(codexConfig, codexWorkspaceStore),
    createReviewCheckpointManager(),
    codexProcessSessions,
    [],
    [],
    codexBundleStore,
  );
  const codexClient = new Client(
    { name: "workspace-bundle-codex-test", version: "1.0.0" },
    { capabilities: {} },
  );
  const [codexClientTransport, codexServerTransport] = InMemoryTransport.createLinkedPair();
  try {
    await codexServer.connect(codexServerTransport);
    await codexClient.connect(codexClientTransport);
    const codexToolNames = (await codexClient.listTools()).tools.map((tool) => tool.name).sort();
    assert.deepEqual(codexToolNames, [
      "apply_patch",
      "exec_command",
      "export_workspace_bundle",
      "launch_workspace_task",
      "open_workspace",
      "probe_embedded_zip_transfer",
      "read",
      "write_stdin",
    ]);
    const codexOpenResult = await codexClient.callTool({
      name: "open_workspace",
      arguments: { path: projectRoot },
    });
    const codexWorkspaceId = (
      codexOpenResult.structuredContent as { workspaceId?: unknown } | undefined
    )?.workspaceId;
    assert.equal(typeof codexWorkspaceId, "string");
    assert.match(
      String((codexOpenResult.structuredContent as { instruction?: unknown } | undefined)?.instruction),
      /ZIP is attached/,
    );
    const automaticBundleResource = (codexOpenResult.content as Array<{
      type?: unknown;
      resource?: { mimeType?: unknown; blob?: unknown; uri?: unknown };
    }>).find((entry) => entry.type === "resource");
    assert.equal(automaticBundleResource?.resource?.mimeType, "application/zip");
    assert.equal(typeof automaticBundleResource?.resource?.blob, "string");
    assert.match(String(automaticBundleResource?.resource?.uri), /^workbridge:\/\/workspace-bundle\//);
    const codexExternalSkillPath = (
      codexOpenResult.structuredContent as { skills?: Array<{ path?: unknown }> } | undefined
    )?.skills?.find((skill) => typeof skill.path === "string")?.path;
    assert.equal(typeof codexExternalSkillPath, "string");
    const blockedReadResult = await codexClient.callTool({
      name: "read",
      arguments: { workspaceId: codexWorkspaceId, path: "src/index.ts" },
    });
    assert.equal(blockedReadResult.isError, undefined);
    assert.match(
      String((blockedReadResult.structuredContent as { result?: unknown } | undefined)?.result),
      /was not executed/,
    );
    const allowedSkillReadResult = await codexClient.callTool({
      name: "read",
      arguments: { workspaceId: codexWorkspaceId, path: codexExternalSkillPath },
    });
    assert.equal(allowedSkillReadResult.isError, undefined);
    assert.match(
      String((allowedSkillReadResult.structuredContent as { result?: unknown } | undefined)?.result),
      /Use the external bundle test instruction/,
    );
    const blockedExecResult = await codexClient.callTool({
      name: "exec_command",
      arguments: {
        workspaceId: codexWorkspaceId,
        cmd: "node -e \"process.exit(17)\"",
      },
    });
    const blockedExecStructured = blockedExecResult.structuredContent as {
      result?: unknown;
      running?: unknown;
      wallTimeMs?: unknown;
      outputTruncated?: unknown;
      sessionId?: unknown;
    } | undefined;
    assert.equal(blockedExecResult.isError, undefined);
    assert.match(String(blockedExecStructured?.result), /was not executed/);
    assert.equal(blockedExecStructured?.running, false);
    assert.equal(blockedExecStructured?.wallTimeMs, 0);
    assert.equal(blockedExecStructured?.outputTruncated, false);
    assert.equal(blockedExecStructured?.sessionId, undefined);
    const blockedWriteResult = await codexClient.callTool({
      name: "write_stdin",
      arguments: {
        workspaceId: codexWorkspaceId,
        sessionId: 999_999,
        chars: "",
      },
    });
    assert.equal(blockedWriteResult.isError, undefined);
    assert.match(
      String((blockedWriteResult.structuredContent as { result?: unknown } | undefined)?.result),
      /was not executed/,
    );
    const blockedWorkspaceTaskResult = await codexClient.callTool({
      name: "launch_workspace_task",
      arguments: {
        workspaceId: codexWorkspaceId,
        task: "aegis_runner",
        template: "status_console_5s",
      },
    });
    assert.equal(blockedWorkspaceTaskResult.isError, undefined);
    assert.match(
      String((blockedWorkspaceTaskResult.structuredContent as { result?: unknown } | undefined)?.result),
      /was not executed/,
    );
    const verificationTaskResult = await codexClient.callTool({
      name: "launch_workspace_task",
      arguments: {
        workspaceId: codexWorkspaceId,
        task: "workspace_verify",
        template: "standard",
        yieldTimeMs: 0,
      },
    });
    assert.equal(verificationTaskResult.isError, undefined);
    const verificationTaskStructured = verificationTaskResult.structuredContent as {
      sessionId?: unknown;
      running?: unknown;
      exitCode?: unknown;
    } | undefined;
    if (verificationTaskStructured?.running === true) {
      assert.equal(typeof verificationTaskStructured.sessionId, "number");
      const verificationPollResult = await codexClient.callTool({
        name: "write_stdin",
        arguments: {
          workspaceId: codexWorkspaceId,
          sessionId: verificationTaskStructured.sessionId,
          chars: "",
          yieldTimeMs: 30_000,
        },
      });
      assert.equal(verificationPollResult.isError, undefined);
      const verificationPollStructured = verificationPollResult.structuredContent as {
        running?: unknown;
        exitCode?: unknown;
      } | undefined;
      assert.equal(verificationPollStructured?.running, false);
      assert.equal(verificationPollStructured?.exitCode, 0);
    } else {
      assert.equal(verificationTaskStructured?.exitCode, 0);
    }
    const policyExportResult = await codexClient.callTool({
      name: "export_workspace_bundle",
      arguments: { workspaceId: codexWorkspaceId },
    });
    assert.equal(policyExportResult.isError, undefined);
    assert.equal(
      typeof (policyExportResult.structuredContent as { bundleId?: unknown } | undefined)?.bundleId,
      "string",
    );

    await writeFile(join(projectRoot, "src", "index.ts"), "export const value = 4;\n", "utf8");
    const staleApplyResult = await codexClient.callTool({
      name: "apply_patch",
      arguments: {
        workspaceId: codexWorkspaceId,
        patch: `*** Begin Patch
*** Update File: src/index.ts
@@
-export const value = 4;
+export const value = 5;
*** End Patch`,
      },
    });
    assert.equal(staleApplyResult.isError, true);
    assert.match(
      JSON.stringify(staleApplyResult.content),
      /Export a new bundle/,
    );
    assert.equal(await readFile(join(projectRoot, "src", "index.ts"), "utf8"), "export const value = 4;\n");

    const freshPolicyExportResult = await codexClient.callTool({
      name: "export_workspace_bundle",
      arguments: { workspaceId: codexWorkspaceId },
    });
    assert.equal(freshPolicyExportResult.isError, undefined);
    const freshApplyResult = await codexClient.callTool({
      name: "apply_patch",
      arguments: {
        workspaceId: codexWorkspaceId,
        patch: `*** Begin Patch
*** Update File: src/index.ts
@@
-export const value = 4;
+export const value = 5;
*** End Patch`,
      },
    });
    assert.equal(freshApplyResult.isError, undefined);
    assert.equal(await readFile(join(projectRoot, "src", "index.ts"), "utf8"), "export const value = 5;\n");

    const consumedBundleApplyResult = await codexClient.callTool({
      name: "apply_patch",
      arguments: {
        workspaceId: codexWorkspaceId,
        patch: `*** Begin Patch
*** Update File: src/index.ts
@@
-export const value = 5;
+export const value = 6;
*** End Patch`,
      },
    });
    assert.equal(consumedBundleApplyResult.isError, true);
    assert.match(
      JSON.stringify(consumedBundleApplyResult.content),
      /No current sandbox bundle/,
    );
    assert.equal(await readFile(join(projectRoot, "src", "index.ts"), "utf8"), "export const value = 5;\n");
  } finally {
    await codexClient.close().catch(() => undefined);
    await codexServer.close().catch(() => undefined);
    codexProcessSessions.shutdown();
    await codexBundleStore.close();
    codexWorkspaceStore.close?.();
  }
} finally {
  await store.close();
  await rm(temporaryRoot, { recursive: true, force: true });
}

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd });
}

function readZipEntries(archive: Buffer): Map<string, Buffer> {
  const entries = new Map<string, Buffer>();
  let offset = 0;
  while (offset + 4 <= archive.length) {
    const signature = archive.readUInt32LE(offset);
    if (signature === 0x02014b50 || signature === 0x06054b50) break;
    assert.equal(signature, 0x04034b50);
    const method = archive.readUInt16LE(offset + 8);
    const compressedSize = archive.readUInt32LE(offset + 18);
    const fileNameLength = archive.readUInt16LE(offset + 26);
    const extraLength = archive.readUInt16LE(offset + 28);
    const nameStart = offset + 30;
    const dataStart = nameStart + fileNameLength + extraLength;
    const name = archive.subarray(nameStart, nameStart + fileNameLength).toString("utf8");
    const compressed = archive.subarray(dataStart, dataStart + compressedSize);
    assert.equal(method, 8);
    entries.set(name, inflateRawSync(compressed));
    offset = dataStart + compressedSize;
  }
  return entries;
}
