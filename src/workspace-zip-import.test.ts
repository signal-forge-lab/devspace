import { createServer, type Server } from "node:http";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import assert from "node:assert/strict";
import { WorkspaceZipExportStore } from "./workspace-zip-export.js";
import { WorkspaceZipImportStore } from "./workspace-zip-import.js";
import type { Workspace } from "./workspaces.js";

const execFileAsync = promisify(execFile);
const root = await mkdtemp(join(tmpdir(), "devspace-zip-import-"));
let server: Server | undefined;
try {
  await execFileAsync("git", ["init"], { cwd: root });
  await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: root });
  await execFileAsync("git", ["config", "user.name", "Test User"], { cwd: root });
  await writeFile(join(root, "README.md"), "hello\n", "utf8");
  await execFileAsync("git", ["add", "README.md"], { cwd: root });
  await execFileAsync("git", ["commit", "-m", "init"], { cwd: root });

  const workspace: Workspace = {
    id: "ws_import_test",
    root,
    mode: "checkout",
    skills: [],
    skillDiagnostics: [],
    activatedSkillDirs: new Set(),
  };
  const exportStore = new WorkspaceZipExportStore();
  const exported = await exportStore.exportWorkspaceZip(workspace, { outputName: "source.zip", includeManifest: true });
  const zip = await readFile(exported.zipPath);
  const file = new File([zip], "incoming.zip", { type: "application/zip" });

  const importStore = new WorkspaceZipImportStore();
  const shape = importStore.probeImportArgumentShape(file);
  assert.equal(shape.valueKind, "object");
  assert.equal(shape.hasArrayBuffer, true);
  assert.equal(shape.hasName, true);
  assert.equal(shape.name, "incoming.zip");

  const pathShape = importStore.probeImportArgumentShape("/mnt/data/incoming.zip");
  assert.equal(pathShape.valueKind, "string");
  assert.equal(pathShape.stringKind, "unix_path");

  const probed = await importStore.probeImportFile(file);
  assert.equal(probed.originalName, "incoming.zip");
  assert.equal(probed.sizeBytes, zip.length);
  assert.equal(probed.sha256, exported.sha256);

  await assert.rejects(
    () => importStore.probeImportFile("/mnt/data/incoming.zip"),
    /host may not have rewritten the uploaded file argument/,
  );

  const imported = await importStore.importZipFile(workspace, file, { expectedSha256: exported.sha256 });
  assert.equal(imported.originalName, "incoming.zip");
  assert.equal(imported.manifestPresent, true);
  assert.equal(imported.entryCount, exported.fileCount);
  assert.equal(imported.sourceZipPath.endsWith("source.zip"), true);
  assert.equal((await stat(imported.sourceZipPath)).size, zip.length);
  assert.equal(existsSync(join(imported.importDir, "import.json")), true);

  const extractStoreAfterRestart = new WorkspaceZipImportStore();
  const extracted = await extractStoreAfterRestart.extractImportedZip(workspace, imported.importId);
  assert.equal(extracted.workspaceId, workspace.id);
  assert.equal(extracted.fileCount, exported.fileCount);
  assert.equal(existsSync(join(extracted.extractDir, "README.md")), true);
  assert.equal(existsSync(join(extracted.extractDir, "manifest.json")), true);
  assert.ok(extracted.files.includes("README.md"));

  const zipWithDirectory = await readFile(await createZipWithDirectoryEntry(root));
  const directoryFile = new File([zipWithDirectory], "directory-entry.zip", { type: "application/zip" });
  const importedWithDirectory = await new WorkspaceZipImportStore().importZipFile(workspace, directoryFile);
  assert.equal(importedWithDirectory.entryCount, 1);
  assert.equal(importedWithDirectory.totalUncompressedBytes, "inside\n".length);

  const served = await serveBuffer(zip, "application/zip");
  server = served.server;
  const importedFromUrl = await new WorkspaceZipImportStore().importZipFile(workspace, served.url, { expectedSha256: exported.sha256 });
  assert.equal(importedFromUrl.originalName, "incoming.zip");
  assert.equal(importedFromUrl.sha256, exported.sha256);
  assert.equal(importedFromUrl.entryCount, exported.fileCount);
} finally {
  await new Promise<void>((resolve) => server?.close(() => resolve()) ?? resolve());
  await rm(root, { recursive: true, force: true });
}

async function createZipWithDirectoryEntry(rootDir: string): Promise<string> {
  const zipPath = join(rootDir, "directory-entry.zip");
  const script = [
    "import zipfile, sys",
    "with zipfile.ZipFile(sys.argv[1], 'w', compression=zipfile.ZIP_DEFLATED) as z:",
    "    z.writestr('folder/', '')",
    "    z.writestr('folder/file.txt', 'inside\\n')",
  ].join("\n");
  try {
    await execFileAsync("python", ["-c", script, zipPath]);
  } catch {
    await execFileAsync("py", ["-3", "-c", script, zipPath]);
  }
  return zipPath;
}

async function serveBuffer(data: Buffer, contentType: string): Promise<{ server: Server; url: string }> {
  const server = createServer((request, response) => {
    if (request.url !== "/incoming.zip") {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, {
      "content-type": contentType,
      "content-length": String(data.length),
    });
    response.end(data);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected TCP server address.");
  return { server, url: `http://127.0.0.1:${address.port}/incoming.zip` };
}
