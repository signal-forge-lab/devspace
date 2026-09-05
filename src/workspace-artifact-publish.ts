import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, open, realpath, type FileHandle } from "node:fs/promises";
import { basename, join } from "node:path";
import { isPathInsideRoot } from "./roots.js";

export const MAX_EMBEDDED_ZIP_BYTES = 10 * 1024 * 1024;
const READ_CHUNK_BYTES = 64 * 1024;
const NO_FOLLOW = fsConstants.O_NOFOLLOW ?? 0;

export type WorkspaceArtifactPublishErrorCode =
  | "artifact_path_invalid"
  | "artifact_not_found"
  | "artifact_symlink_unsafe"
  | "artifact_not_file"
  | "artifact_too_large"
  | "artifact_not_zip"
  | "artifact_changed_during_read";

export class WorkspaceArtifactPublishError extends Error {
  constructor(
    readonly code: WorkspaceArtifactPublishErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "WorkspaceArtifactPublishError";
  }
}

export interface WorkspaceZipArtifact {
  path: string;
  fileName: string;
  mimeType: "application/zip";
  sizeBytes: number;
  sha256: string;
  resourceUri: string;
}

export interface PublishedWorkspaceZip extends WorkspaceZipArtifact {
  blob: string;
}

interface LoadedWorkspaceZip extends WorkspaceZipArtifact {
  bytes: Buffer;
}

export async function inspectWorkspaceZip(input: {
  workspaceRoot: string;
  path: string;
  maxBytes?: number;
}): Promise<WorkspaceZipArtifact> {
  const loaded = await loadWorkspaceZip(input);
  return withoutBytes(loaded);
}

export async function publishWorkspaceZip(input: {
  workspaceRoot: string;
  path: string;
  maxBytes?: number;
}): Promise<PublishedWorkspaceZip> {
  const loaded = await loadWorkspaceZip(input);
  return {
    ...withoutBytes(loaded),
    blob: loaded.bytes.toString("base64"),
  };
}

async function loadWorkspaceZip({
  workspaceRoot,
  path,
  maxBytes = MAX_EMBEDDED_ZIP_BYTES,
}: {
  workspaceRoot: string;
  path: string;
  maxBytes?: number;
}): Promise<LoadedWorkspaceZip> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new WorkspaceArtifactPublishError(
      "artifact_too_large",
      "Embedded ZIP size limit must be a positive integer.",
    );
  }

  const normalizedPath = normalizeRelativeZipPath(path);
  const root = await realpath(workspaceRoot);
  const parts = normalizedPath.split("/");
  let candidate = root;
  let metadata: Awaited<ReturnType<typeof lstat>> | undefined;

  for (const [index, part] of parts.entries()) {
    candidate = join(candidate, part);
    try {
      metadata = await lstat(candidate);
    } catch (error) {
      if (isMissingPathError(error)) {
        throw new WorkspaceArtifactPublishError(
          "artifact_not_found",
          `ZIP artifact does not exist: ${normalizedPath}`,
        );
      }
      throw error;
    }
    if (metadata.isSymbolicLink()) {
      throw new WorkspaceArtifactPublishError(
        "artifact_symlink_unsafe",
        `ZIP artifact path must not contain symbolic links: ${normalizedPath}`,
      );
    }
    if (index < parts.length - 1 && !metadata.isDirectory()) {
      throw new WorkspaceArtifactPublishError(
        "artifact_not_found",
        `ZIP artifact does not exist: ${normalizedPath}`,
      );
    }
  }

  if (!metadata?.isFile()) {
    throw new WorkspaceArtifactPublishError(
      "artifact_not_file",
      `ZIP artifact must be a regular file: ${normalizedPath}`,
    );
  }
  if (metadata.size > maxBytes) {
    throw new WorkspaceArtifactPublishError(
      "artifact_too_large",
      `ZIP artifact exceeds the ${maxBytes}-byte embedded transfer limit: ${normalizedPath}`,
    );
  }

  const canonicalPath = await realpath(candidate);
  if (!isPathInsideRoot(canonicalPath, root)) {
    throw new WorkspaceArtifactPublishError(
      "artifact_symlink_unsafe",
      `ZIP artifact resolves outside the selected workspace: ${normalizedPath}`,
    );
  }

  let handle: FileHandle | undefined;
  try {
    handle = await open(candidate, fsConstants.O_RDONLY | NO_FOLLOW);
    const openedMetadata = await handle.stat();
    assertSameFile(metadata, openedMetadata, normalizedPath);
    const bytes = await readBounded(handle, maxBytes, normalizedPath);
    const finalMetadata = await handle.stat();
    assertSameFile(openedMetadata, finalMetadata, normalizedPath);
    if (BigInt(bytes.length) !== BigInt(finalMetadata.size)) {
      throw new WorkspaceArtifactPublishError(
        "artifact_changed_during_read",
        `ZIP artifact changed while it was being read: ${normalizedPath}`,
      );
    }
    assertZipSignature(bytes, normalizedPath);
    const digest = createHash("sha256").update(bytes).digest("hex");
    const fileName = basename(normalizedPath);
    return {
      path: normalizedPath,
      fileName,
      mimeType: "application/zip",
      sizeBytes: bytes.length,
      sha256: `sha256:${digest}`,
      resourceUri: `workbridge://published-artifact/${digest}/${encodeURIComponent(fileName)}`,
      bytes,
    };
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function readBounded(handle: FileHandle, maxBytes: number, path: string): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  while (totalBytes <= maxBytes) {
    const remaining = maxBytes + 1 - totalBytes;
    const chunk = Buffer.allocUnsafe(Math.min(READ_CHUNK_BYTES, remaining));
    const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
    if (bytesRead === 0) break;
    chunks.push(chunk.subarray(0, bytesRead));
    totalBytes += bytesRead;
  }
  if (totalBytes > maxBytes) {
    throw new WorkspaceArtifactPublishError(
      "artifact_too_large",
      `ZIP artifact exceeds the ${maxBytes}-byte embedded transfer limit: ${path}`,
    );
  }
  return Buffer.concat(chunks, totalBytes);
}

function normalizeRelativeZipPath(input: string): string {
  const trimmed = input.trim();
  if (!trimmed || /[\u0000-\u001f\u007f]/.test(trimmed)) {
    throw new WorkspaceArtifactPublishError(
      "artifact_path_invalid",
      "publish_artifact requires a non-empty ZIP path without control characters.",
    );
  }
  if (/^[\\/]/.test(trimmed) || /^[A-Za-z]:[\\/]/.test(trimmed)) {
    throw new WorkspaceArtifactPublishError(
      "artifact_path_invalid",
      "publish_artifact path must be relative to the selected workspace.",
    );
  }

  const parts = trimmed.split(/[\\/]+/).filter((part) => part !== "" && part !== ".");
  if (parts.length === 0 || parts.some((part) => part === "..")) {
    throw new WorkspaceArtifactPublishError(
      "artifact_path_invalid",
      "publish_artifact path must not contain traversal segments.",
    );
  }
  const normalized = parts.join("/");
  if (!normalized.toLowerCase().endsWith(".zip")) {
    throw new WorkspaceArtifactPublishError(
      "artifact_path_invalid",
      "publish_artifact/embedded_zip accepts only .zip files.",
    );
  }
  return normalized;
}

function assertSameFile(
  expected: { dev: number | bigint; ino: number | bigint; size: number | bigint },
  actual: { dev: number | bigint; ino: number | bigint; size: number | bigint },
  path: string,
): void {
  if (
    expected.dev !== actual.dev
    || expected.ino !== actual.ino
    || expected.size !== actual.size
  ) {
    throw new WorkspaceArtifactPublishError(
      "artifact_changed_during_read",
      `ZIP artifact changed before it could be published: ${path}`,
    );
  }
}

function assertZipSignature(bytes: Buffer, path: string): void {
  const signature = bytes.subarray(0, 4).toString("hex");
  if (signature !== "504b0304" && signature !== "504b0506" && signature !== "504b0708") {
    throw new WorkspaceArtifactPublishError(
      "artifact_not_zip",
      `ZIP artifact does not have a valid ZIP signature: ${path}`,
    );
  }
}

function withoutBytes(loaded: LoadedWorkspaceZip): WorkspaceZipArtifact {
  const { bytes: _bytes, ...artifact } = loaded;
  return artifact;
}

function isMissingPathError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error
    && ((error as NodeJS.ErrnoException).code === "ENOENT"
      || (error as NodeJS.ErrnoException).code === "ENOTDIR");
}
