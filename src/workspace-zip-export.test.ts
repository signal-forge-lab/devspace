import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import assert from "node:assert/strict";
import { WorkspaceZipExportStore, exportIdFromResourceUri, ZIP_RESOURCE_MIME_TYPE } from "./workspace-zip-export.js";
import type { Workspace } from "./workspaces.js";

const execFileAsync = promisify(execFile);
const root = await mkdtemp(join(tmpdir(), "devspace-zip-export-"));
try {
  await execFileAsync("git", ["init"], { cwd: root });
  await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: root });
  await execFileAsync("git", ["config", "user.name", "Test User"], { cwd: root });
  await writeFile(join(root, "README.md"), "hello\n", "utf8");
  await writeFile(join(root, ".env"), "SECRET=skip\n", "utf8");
  await execFileAsync("git", ["add", "README.md", ".env"], { cwd: root });
  await execFileAsync("git", ["commit", "-m", "init"], { cwd: root });

  const workspace: Workspace = {
    id: "ws_test",
    root,
    mode: "checkout",
    skills: [],
    skillDiagnostics: [],
    activatedSkillDirs: new Set(),
  };
  const store = new WorkspaceZipExportStore();
  const exported = await store.exportWorkspaceZip(workspace, { outputName: "snapshot.zip", includeManifest: true });
  assert.equal(exported.mode, "git_tracked");
  assert.equal(exported.resourceUri.endsWith(".zip"), true);
  assert.equal(exported.manifestIncluded, true);
  assert.equal(exported.fileCount, 2);
  assert.ok(exported.skippedFiles.includes(".env"));
  assert.equal(exportIdFromResourceUri(new URL(exported.resourceUri)), exported.exportId);

  const zip = await readFile(exported.zipPath);
  assert.equal(zip.readUInt32LE(0), 0x04034b50);
  assert.equal(zip.readUInt16LE(8), 8);
  assert.equal(zip.subarray(-22).readUInt32LE(0), 0x06054b50);
  const centralDirectoryOffset = zip.subarray(-22).readUInt32LE(16);
  assert.equal(zip.readUInt32LE(centralDirectoryOffset), 0x02014b50);
  assert.equal(zip.readUInt16LE(centralDirectoryOffset + 10), 8);
  assert.equal((await store.readExportBlob(exported.exportId)).length > zip.length, true);
  const link = store.createDownloadUrl(exported.exportId, "https://example.test", { ttlSeconds: 60, maxDownloads: 1 });
  assert.equal(store.claimDownload(link.token).exportId, exported.exportId);
  assert.throws(() => store.claimDownload(link.token), /Unknown download token/);
  assert.equal(ZIP_RESOURCE_MIME_TYPE, "application/zip");
} finally {
  await rm(root, { recursive: true, force: true });
}
