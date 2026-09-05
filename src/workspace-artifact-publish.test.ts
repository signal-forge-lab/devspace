import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MAX_EMBEDDED_ZIP_BYTES,
  WorkspaceArtifactPublishError,
  inspectWorkspaceZip,
  publishWorkspaceZip,
} from "./workspace-artifact-publish.js";

const root = await mkdtemp(join(tmpdir(), "workbridge-publish-artifact-test-"));
const outside = await mkdtemp(join(tmpdir(), "workbridge-publish-artifact-outside-"));
const zipBytes = Buffer.from([
  0x50, 0x4b, 0x05, 0x06,
  0x00, 0x00, 0x00, 0x00,
  0x00, 0x00, 0x00, 0x00,
  0x00, 0x00, 0x00, 0x00,
  0x00, 0x00, 0x00, 0x00,
  0x00, 0x00,
]);

try {
  await mkdir(join(root, "dist"), { recursive: true });
  await writeFile(join(root, "dist", "artifact.zip"), zipBytes);

  const inspected = await inspectWorkspaceZip({
    workspaceRoot: root,
    path: "dist/artifact.zip",
  });
  assert.equal(inspected.path, "dist/artifact.zip");
  assert.equal(inspected.fileName, "artifact.zip");
  assert.equal(inspected.mimeType, "application/zip");
  assert.equal(inspected.sizeBytes, zipBytes.length);
  assert.match(inspected.sha256, /^sha256:[a-f0-9]{64}$/);
  assert.match(inspected.resourceUri, /^workbridge:\/\/published-artifact\/[a-f0-9]{64}\/artifact\.zip$/);

  const published = await publishWorkspaceZip({
    workspaceRoot: root,
    path: "dist\\artifact.zip",
  });
  assert.deepEqual(Buffer.from(published.blob, "base64"), zipBytes);

  for (const sizeBytes of [100 * 1024, 1024 * 1024, 5 * 1024 * 1024, MAX_EMBEDDED_ZIP_BYTES]) {
    const fileName = `size-${sizeBytes}.zip`;
    const filePath = join(root, "dist", fileName);
    await writeFile(filePath, zipBytes);
    await truncate(filePath, sizeBytes);
    const sizeProbe = await publishWorkspaceZip({
      workspaceRoot: root,
      path: `dist/${fileName}`,
    });
    assert.equal(sizeProbe.sizeBytes, sizeBytes);
    assert.equal(Buffer.from(sizeProbe.blob, "base64").length, sizeBytes);
  }

  await assertPublishError(root, "../outside.zip", "artifact_path_invalid");
  await assertPublishError(root, "dist/not-zip.txt", "artifact_path_invalid");
  await writeFile(join(root, "dist", "invalid.zip"), "not a zip");
  await assertPublishError(root, "dist/invalid.zip", "artifact_not_zip");
  await mkdir(join(root, "dist", "directory.zip"));
  await assertPublishError(root, "dist/directory.zip", "artifact_not_file");

  const largePath = join(root, "dist", "large.zip");
  await writeFile(largePath, zipBytes);
  await truncate(largePath, MAX_EMBEDDED_ZIP_BYTES + 1);
  await assertPublishError(root, "dist/large.zip", "artifact_too_large");

  await writeFile(join(outside, "outside.zip"), zipBytes);
  try {
    await symlink(
      join(outside, "outside.zip"),
      join(root, "dist", "linked.zip"),
      process.platform === "win32" ? "file" : undefined,
    );
    await assertPublishError(root, "dist/linked.zip", "artifact_symlink_unsafe");
  } catch (error) {
    if (!isSymlinkPrivilegeError(error)) throw error;
  }
} finally {
  await rm(root, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
}

async function assertPublishError(
  workspaceRoot: string,
  path: string,
  code: WorkspaceArtifactPublishError["code"],
): Promise<void> {
  await assert.rejects(
    () => inspectWorkspaceZip({ workspaceRoot, path }),
    (error: unknown) => {
      assert.ok(error instanceof WorkspaceArtifactPublishError);
      assert.equal(error.code, code);
      return true;
    },
  );
}

function isSymlinkPrivilegeError(error: unknown): boolean {
  return error instanceof Error && "code" in error
    && ["EPERM", "EACCES", "UNKNOWN"].includes(String((error as NodeJS.ErrnoException).code));
}

console.log("workspace artifact publish tests passed");
