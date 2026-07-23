import { createHash, randomBytes } from "node:crypto";
import { lstat, mkdir, readFile, readdir, readlink, realpath, rm, stat, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { deflateRawSync } from "node:zlib";
import { git } from "./git.js";
import { isPathInsideRoot } from "./roots.js";
import type { Workspace } from "./workspaces.js";

const DEFAULT_MAX_FILES = 5_000;
const DEFAULT_MAX_SOURCE_BYTES = 50 * 1024 * 1024;
const DEFAULT_MAX_FILE_BYTES = 10 * 1024 * 1024;
const DEFAULT_MAX_ARCHIVE_BYTES = 50 * 1024 * 1024;
const DEFAULT_DOWNLOAD_TTL_MS = 10 * 60 * 1_000;
const DEFAULT_METADATA_TTL_MS = 60 * 60 * 1_000;
const DEFAULT_MAX_DOWNLOADS = 2;
const DEFAULT_STALE_FILE_AGE_MS = 24 * 60 * 60 * 1_000;
const DEFAULT_EXCEPTION_READ_MAX_BYTES = 256 * 1024;
const DEFAULT_MAX_METADATA_RECORDS = 32;
const MANIFEST_PATH = ".workbridge-bundle/manifest.json";
const BUNDLE_ID_PATTERN = /^bundle_[0-9]{8}_[0-9]{6}_[a-f0-9]{10}$/;
const DOWNLOAD_TOKEN_PATTERN = /^[A-Za-z0-9_-]{40,96}$/;

interface ZipEntryInput {
  path: string;
  data: Buffer;
  mtime: Date;
}

interface CentralDirectoryRecord {
  path: string;
  crc32: number;
  compressedSize: number;
  uncompressedSize: number;
  offset: number;
  modTime: number;
  modDate: number;
}

interface DownloadRecord {
  token: string;
  bundleId: string;
  filePath: string;
  fileName: string;
  sizeBytes: number;
  sha256: string;
  expiresAtMs: number;
  maxDownloads: number;
  downloads: number;
}

export type WorkspaceBundleExclusionReason =
  | "reserved_path"
  | "sensitive_path"
  | "symbolic_link"
  | "non_regular_file"
  | "missing_at_export";

export interface WorkspaceBundleExclusion {
  path: string;
  reason: WorkspaceBundleExclusionReason;
  exceptionReadable: boolean;
}

export type WorkspaceBundleReadReason = "excluded_from_bundle" | "external_instruction";

export interface WorkspaceBundleReadResult extends Record<string, unknown> {
  result: string;
  bundleId: string;
  path: string;
  reason: WorkspaceBundleReadReason;
  purpose: string;
  sizeBytes: number;
  sha256: string;
}

export interface WorkspaceBundleReadInput {
  workspace: Workspace;
  bundleId: string;
  requestedPath: string;
  absolutePath: string;
  readRoots: string[];
  reason: WorkspaceBundleReadReason;
  purpose: string;
  externalInstruction: boolean;
}

interface BundleMetadataRecord {
  bundleId: string;
  workspaceId: string;
  workspaceRoot: string;
  gitHead: string;
  workspaceFingerprint: string;
  createdAtMs: number;
  expiresAtMs: number;
  sourcePaths: string[];
  includedFileHashes: Map<string, string>;
  exclusions: Map<string, WorkspaceBundleExclusion>;
}

export interface WorkspaceBundleStoreOptions {
  stateDir: string;
  publicBaseUrl: string;
  now?: () => number;
  randomToken?: () => string;
  maxFiles?: number;
  maxSourceBytes?: number;
  maxFileBytes?: number;
  maxArchiveBytes?: number;
  downloadTtlMs?: number;
  metadataTtlMs?: number;
  maxDownloads?: number;
  staleFileAgeMs?: number;
  exceptionReadMaxBytes?: number;
}

export interface WorkspaceBundleResult extends Record<string, unknown> {
  result: string;
  bundleId: string;
  downloadUrl: string;
  expiresAt: string;
  fileCount: number;
  sizeBytes: number;
  sha256: string;
  excludedFiles: string[];
  exclusions: WorkspaceBundleExclusion[];
}

export interface WorkspaceBundleExport extends WorkspaceBundleResult {
  resourceUri: string;
  fileName: string;
  blob: string;
}

export interface WorkspaceBundleDownload {
  token: string;
  filePath: string;
  fileName: string;
  sizeBytes: number;
  sha256: string;
  expiresAt: string;
  remainingDownloads: number;
}

export interface WorkspaceBundleEmbeddedTransferProbe extends Record<string, unknown> {
  result: string;
  resourceUri: string;
  fileName: string;
  sizeBytes: number;
  sha256: string;
  blob: string;
}

export function createWorkspaceBundleEmbeddedTransferProbe(): WorkspaceBundleEmbeddedTransferProbe {
  const fileName = "workbridge-embedded-resource-probe.zip";
  const resourceUri = "workbridge://transfer-probe/workbridge-embedded-resource-probe-v1.zip";
  const archive = createDeflateZip([{
    path: "workbridge-embedded-resource-probe.txt",
    data: Buffer.from("Workbridge embedded ZIP transfer probe v1.\n", "utf8"),
    mtime: new Date(1980, 0, 1, 0, 0, 0),
  }]);
  return {
    result: `Created a ${archive.length}-byte embedded ZIP transfer probe.`,
    resourceUri,
    fileName,
    sizeBytes: archive.length,
    sha256: hashBuffer(archive),
    blob: archive.toString("base64"),
  };
}

export class WorkspaceBundleStore {
  private readonly directory: string;
  private readonly now: () => number;
  private readonly randomToken: () => string;
  private readonly maxFiles: number;
  private readonly maxSourceBytes: number;
  private readonly maxFileBytes: number;
  private readonly maxArchiveBytes: number;
  private readonly downloadTtlMs: number;
  private readonly metadataTtlMs: number;
  private readonly maxDownloads: number;
  private readonly staleFileAgeMs: number;
  private readonly exceptionReadMaxBytes: number;
  private readonly downloads = new Map<string, DownloadRecord>();
  private readonly metadata = new Map<string, BundleMetadataRecord>();
  private readonly workspaceRootOperationTails = new Map<string, Promise<void>>();
  private initialized = false;

  constructor(private readonly options: WorkspaceBundleStoreOptions) {
    this.directory = join(options.stateDir, "exports", "sandbox-bundles");
    this.now = options.now ?? Date.now;
    this.randomToken = options.randomToken ?? (() => randomBytes(32).toString("base64url"));
    this.maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;
    this.maxSourceBytes = options.maxSourceBytes ?? DEFAULT_MAX_SOURCE_BYTES;
    this.maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
    this.maxArchiveBytes = options.maxArchiveBytes ?? DEFAULT_MAX_ARCHIVE_BYTES;
    this.downloadTtlMs = options.downloadTtlMs ?? DEFAULT_DOWNLOAD_TTL_MS;
    this.metadataTtlMs = options.metadataTtlMs ?? DEFAULT_METADATA_TTL_MS;
    this.maxDownloads = options.maxDownloads ?? DEFAULT_MAX_DOWNLOADS;
    this.staleFileAgeMs = options.staleFileAgeMs ?? DEFAULT_STALE_FILE_AGE_MS;
    this.exceptionReadMaxBytes = options.exceptionReadMaxBytes ?? DEFAULT_EXCEPTION_READ_MAX_BYTES;
    validatePositiveInteger(this.maxFiles, "maxFiles");
    validatePositiveInteger(this.maxSourceBytes, "maxSourceBytes");
    validatePositiveInteger(this.maxFileBytes, "maxFileBytes");
    validatePositiveInteger(this.maxArchiveBytes, "maxArchiveBytes");
    validatePositiveInteger(this.downloadTtlMs, "downloadTtlMs");
    validatePositiveInteger(this.metadataTtlMs, "metadataTtlMs");
    validatePositiveInteger(this.maxDownloads, "maxDownloads");
    validatePositiveInteger(this.staleFileAgeMs, "staleFileAgeMs");
    validatePositiveInteger(this.exceptionReadMaxBytes, "exceptionReadMaxBytes");
  }

  async exportWorkspace(workspace: Workspace): Promise<WorkspaceBundleExport> {
    const workspaceRoot = await realpath(workspace.root);
    return this.runWorkspaceExclusive(
      workspaceRoot,
      async () => this.exportWorkspaceUnlocked(workspace, workspaceRoot),
    );
  }

  private async exportWorkspaceUnlocked(
    workspace: Workspace,
    workspaceRoot: string,
  ): Promise<WorkspaceBundleExport> {
    await this.ensureInitialized();
    await this.cleanupExpiredDownloads();
    this.cleanupExpiredMetadata();

    const gitRoot = await realpath((await git(workspaceRoot, ["rev-parse", "--show-toplevel"])).stdout.trim());
    if (!samePath(workspaceRoot, gitRoot)) {
      throw new Error("Sandbox bundle export currently requires the opened workspace to be the Git repository root.");
    }

    const bundleId = makeBundleId(new Date(this.now()));
    const fileName = `${sanitizeFileName(basename(workspaceRoot))}-${bundleId}.zip`;
    const filePath = join(this.directory, fileName);
    const sourcePaths = await listWorkingTreeFiles(workspaceRoot);
    if (sourcePaths.length > this.maxFiles) {
      throw new Error(`Workspace contains ${sourcePaths.length} exportable files; the limit is ${this.maxFiles}.`);
    }

    const entries: ZipEntryInput[] = [];
    const exclusions: WorkspaceBundleExclusion[] = [];
    const exclude = (
      path: string,
      reason: WorkspaceBundleExclusionReason,
      exceptionReadable: boolean,
    ) => {
      exclusions.push({ path, reason, exceptionReadable });
    };
    let sourceBytes = 0;

    for (const sourcePath of sourcePaths) {
      const normalizedPath = normalizeArchivePath(sourcePath);
      if (!normalizedPath || normalizedPath === MANIFEST_PATH || normalizedPath.startsWith(".workbridge-bundle/")) {
        exclude(normalizedPath || sourcePath, "reserved_path", false);
        continue;
      }
      if (isSensitivePath(normalizedPath)) {
        exclude(normalizedPath, "sensitive_path", false);
        continue;
      }

      const absolutePath = resolve(workspaceRoot, ...normalizedPath.split("/"));
      if (!isPathInsideRoot(absolutePath, workspaceRoot)) {
        throw new Error(`Bundle path escaped the workspace root: ${normalizedPath}`);
      }

      let stats;
      try {
        stats = await lstat(absolutePath);
      } catch (error) {
        if (isMissingPathError(error)) {
          exclude(normalizedPath, "missing_at_export", false);
          continue;
        }
        throw error;
      }
      if (stats.isSymbolicLink()) {
        exclude(normalizedPath, "symbolic_link", false);
        continue;
      }
      if (!stats.isFile()) {
        exclude(normalizedPath, "non_regular_file", false);
        continue;
      }
      if (stats.size > this.maxFileBytes) {
        throw new Error(`File exceeds the per-file bundle limit: ${normalizedPath} (${stats.size} bytes).`);
      }

      const resolvedFile = await realpath(absolutePath);
      if (!isPathInsideRoot(resolvedFile, workspaceRoot)) {
        throw new Error(`Bundle file resolves outside the workspace root: ${normalizedPath}`);
      }
      const data = await readFile(resolvedFile);
      sourceBytes += data.length;
      if (sourceBytes > this.maxSourceBytes) {
        throw new Error(`Workspace source exceeds the bundle limit of ${this.maxSourceBytes} bytes.`);
      }
      entries.push({ path: normalizedPath, data, mtime: stats.mtime });
    }

    const gitHead = (await git(workspaceRoot, ["rev-parse", "HEAD"])).stdout.trim();
    const branch = (await git(workspaceRoot, ["branch", "--show-current"])).stdout.trim() || null;
    const statusPorcelain = (await git(workspaceRoot, ["status", "--porcelain=v1", "--untracked-files=normal"])).stdout;
    const workspaceFingerprint = await createWorkspaceFingerprint(workspaceRoot, sourcePaths, gitHead);
    const manifest = {
      formatVersion: 2,
      bundleId,
      createdAt: new Date(this.now()).toISOString(),
      source: {
        workspaceId: workspace.id,
        workspaceName: basename(workspaceRoot),
        gitHead,
        branch,
        dirty: statusPorcelain.trim().length > 0,
      },
      limits: {
        maxFiles: this.maxFiles,
        maxSourceBytes: this.maxSourceBytes,
        maxFileBytes: this.maxFileBytes,
        maxArchiveBytes: this.maxArchiveBytes,
      },
      excludedFiles: exclusions.map((entry) => entry.path),
      exclusions,
      securityNotice:
        "Common secret paths and symbolic links were excluded, but this is not a content-level secret scan. Review the manifest before sharing the archive outside the intended ChatGPT sandbox workflow.",
      files: entries.map((entry) => ({
        path: entry.path,
        sizeBytes: entry.data.length,
        sha256: hashBuffer(entry.data),
      })),
    };
    entries.push({
      path: MANIFEST_PATH,
      data: Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8"),
      mtime: new Date(this.now()),
    });

    const archive = createDeflateZip(entries);
    if (archive.length > this.maxArchiveBytes) {
      throw new Error(`Generated bundle exceeds the archive limit of ${this.maxArchiveBytes} bytes.`);
    }
    await writeFile(filePath, archive, { mode: 0o600 });

    const token = this.randomToken();
    if (!DOWNLOAD_TOKEN_PATTERN.test(token)) {
      await rm(filePath, { force: true });
      throw new Error("Generated an invalid bundle download token.");
    }
    const expiresAtMs = this.now() + this.downloadTtlMs;
    const sha256 = hashBuffer(archive);
    this.downloads.set(token, {
      token,
      bundleId,
      filePath,
      fileName,
      sizeBytes: archive.length,
      sha256,
      expiresAtMs,
      maxDownloads: this.maxDownloads,
      downloads: 0,
    });
    while (this.metadata.size >= DEFAULT_MAX_METADATA_RECORDS) {
      const oldest = Array.from(this.metadata.values())
        .sort((left, right) => left.createdAtMs - right.createdAtMs)[0];
      if (!oldest) break;
      this.metadata.delete(oldest.bundleId);
    }
    const metadataRecord: BundleMetadataRecord = {
      bundleId,
      workspaceId: workspace.id,
      workspaceRoot,
      gitHead,
      workspaceFingerprint,
      createdAtMs: this.now(),
      expiresAtMs: this.now() + this.metadataTtlMs,
      sourcePaths: [...sourcePaths],
      includedFileHashes: new Map(entries
        .filter((entry) => entry.path !== MANIFEST_PATH)
        .map((entry) => [entry.path, hashBuffer(entry.data)])),
      exclusions: new Map(exclusions.map((entry) => [entry.path, entry])),
    };
    try {
      await this.assertBundleCurrent(metadataRecord);
    } catch (error) {
      this.downloads.delete(token);
      await rm(filePath, { force: true });
      throw error;
    }
    this.metadata.set(bundleId, metadataRecord);

    const downloadUrl = new URL(
      `/workbridge-bundles/${encodeURIComponent(token)}/workspace.zip`,
      this.options.publicBaseUrl,
    ).toString();
    const resourceUri = `workbridge://workspace-bundle/${bundleId}/${encodeURIComponent(fileName)}`;
    return {
      result: `Created sandbox bundle ${bundleId} with ${entries.length - 1} project files. The temporary URL expires at ${new Date(expiresAtMs).toISOString()}.`,
      bundleId,
      downloadUrl,
      resourceUri,
      fileName,
      expiresAt: new Date(expiresAtMs).toISOString(),
      fileCount: entries.length - 1,
      sizeBytes: archive.length,
      sha256,
      excludedFiles: exclusions.map((entry) => entry.path),
      exclusions,
      blob: archive.toString("base64"),
    };
  }

  async applyPatchFromLatestBundle<T>(
    workspace: Workspace,
    apply: (beforeCommit: () => Promise<void>) => Promise<T>,
  ): Promise<T> {
    const workspaceRoot = await realpath(workspace.root);
    return this.runWorkspaceExclusive(workspaceRoot, async () => {
      this.cleanupExpiredMetadata();
      const record = this.latestWorkspaceRecord(workspace.id, workspaceRoot);
      if (!record) {
        throw new Error("No current sandbox bundle exists for this workspace. Export a new bundle before applying a patch.");
      }
      await this.assertWorkspaceRecordCurrent(workspace, workspaceRoot, record);
      let beforeCommitChecked = false;
      const result = await apply(async () => {
        this.cleanupExpiredMetadata();
        const latest = this.latestWorkspaceRecord(workspace.id, workspaceRoot);
        if (!latest || latest.bundleId !== record.bundleId) {
          throw new Error("The active sandbox bundle changed before patch commit. Export a new bundle and regenerate the patch.");
        }
        await this.assertWorkspaceRecordCurrent(workspace, workspaceRoot, record);
        beforeCommitChecked = true;
      });
      if (!beforeCommitChecked) {
        throw new Error("Patch commit was not guarded by the required sandbox bundle freshness check.");
      }
      await this.consumeWorkspaceRecords(workspaceRoot);
      return result;
    });
  }

  async readUnbundledFile(input: WorkspaceBundleReadInput): Promise<WorkspaceBundleReadResult> {
    this.cleanupExpiredMetadata();
    if (!BUNDLE_ID_PATTERN.test(input.bundleId)) throw new Error("Unknown workspace bundle.");
    const record = this.metadata.get(input.bundleId);
    if (!record) throw new Error("Unknown or expired workspace bundle. Export a new bundle.");

    const workspaceRoot = await realpath(input.workspace.root);
    if (record.workspaceId !== input.workspace.id || !samePath(record.workspaceRoot, workspaceRoot)) {
      throw new Error("The bundle does not belong to this workspace.");
    }
    await this.assertBundleCurrent(record);

    const purpose = input.purpose.trim();
    if (purpose.length < 8 || purpose.length > 200) {
      throw new Error("Exceptional read purpose must be between 8 and 200 characters.");
    }

    let displayPath = input.requestedPath;
    if (input.reason === "external_instruction") {
      if (!input.externalInstruction) {
        throw new Error("external_instruction is only valid for an advertised external skill file.");
      }
    } else {
      if (input.externalInstruction) {
        throw new Error("Use reason=external_instruction for advertised external skill files.");
      }
      const normalizedPath = normalizeArchivePath(input.requestedPath);
      if (!normalizedPath) throw new Error("Exceptional workspace reads require a relative file path.");
      displayPath = normalizedPath;
      if (record.includedFileHashes.has(normalizedPath)) {
        throw new Error("The requested file is present in the referenced bundle. Read the sandbox copy instead.");
      }
      if (isSensitivePath(normalizedPath)) {
        throw new Error("Sensitive paths excluded from a bundle cannot be read through the exception tool.");
      }
      const exclusion = record.exclusions.get(normalizedPath);
      if (exclusion && !exclusion.exceptionReadable) {
        throw new Error(`The requested exclusion is not exception-readable: ${exclusion.reason}.`);
      }
    }

    const pathStats = await lstat(input.absolutePath);
    if (pathStats.isSymbolicLink()) {
      throw new Error("Symbolic links cannot be read through the exception tool.");
    }
    if (!pathStats.isFile()) throw new Error("Exceptional reads require a regular file.");
    if (pathStats.size > this.exceptionReadMaxBytes) {
      throw new Error(`Exceptional file exceeds the ${this.exceptionReadMaxBytes}-byte text limit.`);
    }
    const resolvedPath = await realpath(input.absolutePath);
    if (!input.readRoots.some((root) => isPathInsideRoot(resolvedPath, root))) {
      throw new Error("Exceptional read resolved outside its approved root.");
    }
    const data = await readFile(resolvedPath);
    const text = decodeUtf8Text(data);
    const sha256 = hashBuffer(data);
    return {
      result: [
        `Exceptional read from bundle ${input.bundleId}: ${displayPath}`,
        `Reason: ${input.reason}`,
        `Purpose: ${purpose}`,
        "",
        text,
      ].join("\n"),
      bundleId: input.bundleId,
      path: displayPath,
      reason: input.reason,
      purpose,
      sizeBytes: data.length,
      sha256,
    };
  }

  peekDownload(token: string): WorkspaceBundleDownload {
    this.cleanupExpiredRecordsSync();
    return downloadView(this.requireDownload(token));
  }

  claimDownload(token: string): WorkspaceBundleDownload {
    this.cleanupExpiredRecordsSync();
    const record = this.requireDownload(token);
    if (record.downloads >= record.maxDownloads) {
      throw new Error("Bundle download limit reached.");
    }
    record.downloads += 1;
    return downloadView(record);
  }

  async completeDownload(token: string, succeeded: boolean): Promise<void> {
    const record = this.downloads.get(token);
    if (!record) return;
    if (!succeeded) {
      record.downloads = Math.max(0, record.downloads - 1);
      return;
    }
    if (record.downloads >= record.maxDownloads) {
      this.downloads.delete(token);
      await rm(record.filePath, { force: true });
    }
  }

  async close(): Promise<void> {
    const records = Array.from(this.downloads.values());
    this.downloads.clear();
    this.metadata.clear();
    await Promise.all(records.map((record) => rm(record.filePath, { force: true })));
  }

  private async assertBundleCurrent(record: BundleMetadataRecord): Promise<void> {
    if (record.expiresAtMs <= this.now()) {
      throw new Error("The sandbox bundle expired. Export a new bundle.");
    }
    const currentHead = (await git(record.workspaceRoot, ["rev-parse", "HEAD"])).stdout.trim();
    if (currentHead !== record.gitHead) {
      throw new Error("The workspace changed after this bundle was created. Export a new bundle.");
    }
    const currentPaths = await listWorkingTreeFiles(record.workspaceRoot);
    if (!sameStringArray(currentPaths, record.sourcePaths)) {
      throw new Error("The workspace changed after this bundle was created. Export a new bundle.");
    }
    const currentFingerprint = await createWorkspaceFingerprint(record.workspaceRoot, currentPaths, currentHead);
    if (currentFingerprint !== record.workspaceFingerprint) {
      throw new Error("The workspace changed after this bundle was created. Export a new bundle.");
    }
    for (const [path, expectedHash] of record.includedFileHashes) {
      const absolutePath = resolve(record.workspaceRoot, ...path.split("/"));
      let data: Buffer;
      try {
        const stats = await lstat(absolutePath);
        if (!stats.isFile() || stats.isSymbolicLink()) {
          throw new Error("not a regular file");
        }
        data = await readFile(await realpath(absolutePath));
      } catch {
        throw new Error("The workspace changed after this bundle was created. Export a new bundle.");
      }
      if (hashBuffer(data) !== expectedHash) {
        throw new Error("The workspace changed after this bundle was created. Export a new bundle.");
      }
    }
  }

  private latestWorkspaceRecord(workspaceId: string, workspaceRoot: string): BundleMetadataRecord | undefined {
    return Array.from(this.metadata.values())
      .reverse()
      .find((record) => record.workspaceId === workspaceId && samePath(record.workspaceRoot, workspaceRoot));
  }

  private async assertWorkspaceRecordCurrent(
    workspace: Workspace,
    workspaceRoot: string,
    record: BundleMetadataRecord,
  ): Promise<void> {
    if (record.workspaceId !== workspace.id || !samePath(record.workspaceRoot, workspaceRoot)) {
      throw new Error("The sandbox bundle does not belong to this workspace.");
    }
    await this.assertBundleCurrent(record);
  }

  private async consumeWorkspaceRecords(workspaceRoot: string): Promise<void> {
    const bundleIds = new Set(
      Array.from(this.metadata.values())
        .filter((record) => samePath(record.workspaceRoot, workspaceRoot))
        .map((record) => record.bundleId),
    );
    for (const bundleId of bundleIds) this.metadata.delete(bundleId);
    const downloads = Array.from(this.downloads.values())
      .filter((record) => bundleIds.has(record.bundleId));
    for (const record of downloads) this.downloads.delete(record.token);
    await Promise.all(downloads.map((record) => rm(record.filePath, { force: true }).catch(() => undefined)));
  }

  private async runWorkspaceExclusive<T>(workspaceRoot: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.workspaceRootOperationTails.get(workspaceRoot) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolveCurrent) => {
      release = () => resolveCurrent();
    });
    const tail = previous.catch(() => undefined).then(() => current);
    this.workspaceRootOperationTails.set(workspaceRoot, tail);
    await previous.catch(() => undefined);
    try {
      return await operation();
    } finally {
      release();
      if (this.workspaceRootOperationTails.get(workspaceRoot) === tail) {
        this.workspaceRootOperationTails.delete(workspaceRoot);
      }
    }
  }

  private async ensureInitialized(): Promise<void> {
    if (this.initialized) return;
    await mkdir(this.directory, { recursive: true });
    await cleanupStaleBundleFiles(this.directory, this.now() - this.staleFileAgeMs);
    this.initialized = true;
  }

  private async cleanupExpiredDownloads(): Promise<void> {
    const expired = Array.from(this.downloads.values()).filter((record) => record.expiresAtMs <= this.now());
    for (const record of expired) this.downloads.delete(record.token);
    await Promise.all(expired.map((record) => rm(record.filePath, { force: true })));
  }

  private cleanupExpiredMetadata(): void {
    const now = this.now();
    for (const [bundleId, record] of this.metadata) {
      if (record.expiresAtMs <= now) this.metadata.delete(bundleId);
    }
  }

  private cleanupExpiredRecordsSync(): void {
    const now = this.now();
    for (const [token, record] of this.downloads) {
      if (record.expiresAtMs > now) continue;
      this.downloads.delete(token);
      void rm(record.filePath, { force: true });
    }
  }

  private requireDownload(token: string): DownloadRecord {
    if (!DOWNLOAD_TOKEN_PATTERN.test(token)) throw new Error("Unknown bundle download token.");
    const record = this.downloads.get(token);
    if (!record) throw new Error("Unknown bundle download token.");
    return record;
  }
}

export function redactWorkspaceBundleRequestPath(path: string): string {
  return path.replace(
    /^\/workbridge-bundles\/[^/]+\/workspace\.zip$/,
    "/workbridge-bundles/<token>/workspace.zip",
  );
}

async function createWorkspaceFingerprint(
  root: string,
  sourcePaths: readonly string[],
  gitHead: string,
): Promise<string> {
  const fingerprint = createHash("sha256");
  fingerprint.update("workbridge-workspace-fingerprint-v1\0");
  fingerprint.update(gitHead);
  for (const sourcePath of sourcePaths) {
    const normalizedPath = normalizeArchivePath(sourcePath);
    fingerprint.update("\0path\0");
    fingerprint.update(normalizedPath);
    const absolutePath = resolve(root, ...normalizedPath.split("/"));
    try {
      const stats = await lstat(absolutePath);
      fingerprint.update(`\0mode\0${stats.mode}`);
      if (stats.isSymbolicLink()) {
        fingerprint.update("\0symlink\0");
        fingerprint.update(await readlink(absolutePath));
        continue;
      }
      if (stats.isFile()) {
        const resolvedFile = await realpath(absolutePath);
        if (!isPathInsideRoot(resolvedFile, root)) {
          throw new Error(`Workspace fingerprint path resolves outside the workspace root: ${normalizedPath}`);
        }
        fingerprint.update("\0file\0");
        fingerprint.update(hashBuffer(await readFile(resolvedFile)));
        continue;
      }
      fingerprint.update(`\0other\0${stats.size}`);
    } catch (error) {
      if (!isMissingPathError(error)) throw error;
      fingerprint.update("\0missing");
    }
  }
  return fingerprint.digest("hex");
}

async function listWorkingTreeFiles(root: string): Promise<string[]> {
  const result = await git(root, [
    "ls-files",
    "-z",
    "--cached",
    "--others",
    "--exclude-standard",
  ], { maxBuffer: 32 * 1024 * 1024 });
  return Array.from(new Set(
    result.stdout
      .split("\0")
      .filter(Boolean)
      .map(normalizeArchivePath)
      .filter(Boolean),
  )).sort();
}

async function cleanupStaleBundleFiles(directory: string, cutoffMs: number): Promise<void> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (isMissingPathError(error)) return;
    throw error;
  }
  await Promise.all(entries.map(async (entry) => {
    if (!entry.isFile() || !entry.name.endsWith(".zip")) return;
    const path = join(directory, entry.name);
    const fileStats = await stat(path);
    if (fileStats.mtimeMs < cutoffMs) await rm(path, { force: true });
  }));
}

function downloadView(record: DownloadRecord): WorkspaceBundleDownload {
  return {
    token: record.token,
    filePath: record.filePath,
    fileName: record.fileName,
    sizeBytes: record.sizeBytes,
    sha256: record.sha256,
    expiresAt: new Date(record.expiresAtMs).toISOString(),
    remainingDownloads: Math.max(0, record.maxDownloads - record.downloads),
  };
}

function createDeflateZip(entries: ZipEntryInput[]): Buffer {
  if (entries.length > 0xffff) throw new Error("ZIP entry count exceeds the non-ZIP64 limit.");
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  const records: CentralDirectoryRecord[] = [];
  let offset = 0;

  for (const entry of entries) {
    const path = normalizeArchivePath(entry.path);
    const name = Buffer.from(path, "utf8");
    const compressed = deflateRawSync(entry.data);
    const crc32 = crc32Buffer(entry.data);
    const { modTime, modDate } = dosDateTime(entry.mtime);
    const localHeader = Buffer.alloc(30 + name.length);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0x0800, 6);
    localHeader.writeUInt16LE(8, 8);
    localHeader.writeUInt16LE(modTime, 10);
    localHeader.writeUInt16LE(modDate, 12);
    localHeader.writeUInt32LE(crc32, 14);
    localHeader.writeUInt32LE(compressed.length, 18);
    localHeader.writeUInt32LE(entry.data.length, 22);
    localHeader.writeUInt16LE(name.length, 26);
    localHeader.writeUInt16LE(0, 28);
    name.copy(localHeader, 30);
    localParts.push(localHeader, compressed);
    records.push({
      path,
      crc32,
      compressedSize: compressed.length,
      uncompressedSize: entry.data.length,
      offset,
      modTime,
      modDate,
    });
    offset += localHeader.length + compressed.length;
  }

  const centralStart = offset;
  for (const record of records) {
    const name = Buffer.from(record.path, "utf8");
    const header = Buffer.alloc(46 + name.length);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(20, 6);
    header.writeUInt16LE(0x0800, 8);
    header.writeUInt16LE(8, 10);
    header.writeUInt16LE(record.modTime, 12);
    header.writeUInt16LE(record.modDate, 14);
    header.writeUInt32LE(record.crc32, 16);
    header.writeUInt32LE(record.compressedSize, 20);
    header.writeUInt32LE(record.uncompressedSize, 24);
    header.writeUInt16LE(name.length, 28);
    header.writeUInt16LE(0, 30);
    header.writeUInt16LE(0, 32);
    header.writeUInt16LE(0, 34);
    header.writeUInt16LE(0, 36);
    header.writeUInt32LE(0, 38);
    header.writeUInt32LE(record.offset, 42);
    name.copy(header, 46);
    centralParts.push(header);
    offset += header.length;
  }

  const centralSize = offset - centralStart;
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(records.length, 8);
  eocd.writeUInt16LE(records.length, 10);
  eocd.writeUInt32LE(centralSize, 12);
  eocd.writeUInt32LE(centralStart, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...localParts, ...centralParts, eocd]);
}

function normalizeArchivePath(path: string): string {
  const normalized = path.replaceAll("\\", "/").replace(/^\.\//, "").replace(/^\/+/, "");
  if (!normalized || normalized.includes("\0")) return "";
  const parts = normalized.split("/");
  if (parts.some((part) => part === "" || part === "." || part === "..")) return "";
  return parts.join("/");
}

function isSensitivePath(path: string): boolean {
  const normalized = path.toLowerCase();
  const parts = normalized.split("/");
  const name = parts.at(-1) ?? "";
  if (parts.some((part) => part === ".git" || part === ".ssh" || part === ".aws" || part === ".gnupg")) return true;
  if (name === ".env" || name === ".envrc" || (name.startsWith(".env.") && !isEnvironmentTemplate(name))) return true;
  if (name === ".npmrc" || name === ".pypirc" || name === ".netrc") return true;
  if (/\.(pem|key|p12|pfx|jks|keystore|mobileprovision|tfvars)$/i.test(name)) return true;
  if (/\.tfvars\.json$/i.test(name)) return true;
  if (/^(id_rsa|id_dsa|id_ecdsa|id_ed25519)(\.pub)?$/i.test(name)) return true;
  if (isCredentialDataFile(name)) return true;
  if (normalized === ".docker/config.json" || normalized.endsWith("/.docker/config.json")) return true;
  return false;
}

function isEnvironmentTemplate(name: string): boolean {
  return name.endsWith(".example") || name.endsWith(".sample") || name.endsWith(".template");
}

function isCredentialDataFile(name: string): boolean {
  const lastDot = name.lastIndexOf(".");
  const extension = lastDot > 0 ? name.slice(lastDot + 1) : "";
  const dataExtensions = new Set(["json", "yaml", "yml", "txt", "env", "ini", "toml", "config"]);
  if (lastDot > 0 && !dataExtensions.has(extension.toLowerCase())) return false;
  const stem = lastDot > 0 ? name.slice(0, lastDot) : name;
  return /^(credentials?|secrets?|service-account|token)([-_.][A-Za-z0-9-]+)*$/i.test(stem);
}

function makeBundleId(now: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  const date = `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}`;
  const time = `${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}`;
  const random = randomBytes(8).toString("hex").slice(0, 10);
  const bundleId = `bundle_${date}_${time}_${random}`;
  if (!BUNDLE_ID_PATTERN.test(bundleId)) throw new Error("Failed to create a valid bundle id.");
  return bundleId;
}

function sanitizeFileName(value: string): string {
  const sanitized = value.replace(/[^A-Za-z0-9._-]/g, "_").replace(/^\.+/, "") || "workspace";
  return sanitized.slice(0, 80);
}

function samePath(left: string, right: string): boolean {
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function hashBuffer(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

function decodeUtf8Text(buffer: Buffer): string {
  if (buffer.includes(0)) throw new Error("Exceptional reads support UTF-8 text files only.");
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    throw new Error("Exceptional reads support UTF-8 text files only.");
  }
}

function sameStringArray(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function dosDateTime(date: Date): { modTime: number; modDate: number } {
  const year = Math.min(2107, Math.max(1980, date.getFullYear()));
  const modTime = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  const modDate = ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { modTime, modDate };
}

const CRC_TABLE = createCrcTable();

function crc32Buffer(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function createCrcTable(): number[] {
  const table: number[] = [];
  for (let value = 0; value < 256; value += 1) {
    let crc = value;
    for (let bit = 0; bit < 8; bit += 1) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
    table[value] = crc >>> 0;
  }
  return table;
}

function validatePositiveInteger(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 1) throw new Error(`${name} must be a positive integer.`);
}

function isMissingPathError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error
    && ((error as NodeJS.ErrnoException).code === "ENOENT" || (error as NodeJS.ErrnoException).code === "ENOTDIR");
}
