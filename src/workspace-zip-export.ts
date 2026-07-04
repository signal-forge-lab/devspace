import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, join, relative, sep } from "node:path";
import { deflateRawSync } from "node:zlib";
import { git } from "./git.js";
import type { Workspace } from "./workspaces.js";

export const ZIP_RESOURCE_TEMPLATE = "devspace://exports/{exportId}.zip";
export const ZIP_RESOURCE_MIME_TYPE = "application/zip";
const DEFAULT_MAX_BYTES = 50 * 1024 * 1024;
const DEFAULT_MAX_FILES = 5_000;
const EXPORT_ID_RE = /^exp_[0-9]{8}_[0-9]{6}_[A-Za-z0-9]{8}$/;
const DOWNLOAD_TOKEN_RE = /^[A-Za-z0-9_-]{32,96}$/;
const DEFAULT_DOWNLOAD_TTL_SECONDS = 5 * 60;
const DEFAULT_DOWNLOAD_MAX_DOWNLOADS = 1;

export type WorkspaceZipExportMode = "git_tracked";

export interface ExportWorkspaceZipInput {
  mode?: WorkspaceZipExportMode;
  outputName?: string;
  includeManifest?: boolean;
  maxBytes?: number;
  maxFiles?: number;
}

export interface WorkspaceZipExportResult extends Record<string, unknown> {
  exportId: string;
  resourceUri: string;
  zipPath: string;
  mode: WorkspaceZipExportMode;
  fileCount: number;
  sizeBytes: number;
  sha256: string;
  manifestIncluded: boolean;
  skippedFiles: string[];
  result: string;
}

export interface WorkspaceZipExportRecord extends WorkspaceZipExportResult {
  workspaceId: string;
  workspaceRoot: string;
  createdAt: string;
}

export interface WorkspaceZipDownloadUrlResult extends Record<string, unknown> {
  exportId: string;
  downloadUrl: string;
  token: string;
  expiresAt: string;
  ttlSeconds: number;
  maxDownloads: number;
  result: string;
}

interface WorkspaceZipDownloadRecord {
  token: string;
  exportId: string;
  expiresAtMs: number;
  maxDownloads: number;
  downloads: number;
  createdAt: string;
}

interface ZipEntryInput {
  path: string;
  data: Buffer;
  mtime?: Date;
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

export class WorkspaceZipExportStore {
  private readonly exports = new Map<string, WorkspaceZipExportRecord>();
  private readonly downloads = new Map<string, WorkspaceZipDownloadRecord>();

  async exportWorkspaceZip(workspace: Workspace, input: ExportWorkspaceZipInput = {}): Promise<WorkspaceZipExportResult> {
    const mode = input.mode ?? "git_tracked";
    if (mode !== "git_tracked") throw new Error(`Unsupported export mode: ${mode}`);
    const maxBytes = input.maxBytes ?? DEFAULT_MAX_BYTES;
    const maxFiles = input.maxFiles ?? DEFAULT_MAX_FILES;
    if (!Number.isInteger(maxBytes) || maxBytes < 1) throw new Error("maxBytes must be a positive integer.");
    if (!Number.isInteger(maxFiles) || maxFiles < 1) throw new Error("maxFiles must be a positive integer.");

    const exportId = makeExportId();
    const exportDir = join(workspace.root, ".devspace", "exports");
    await mkdir(exportDir, { recursive: true });
    const outputName = sanitizeZipName(input.outputName ?? `${basename(workspace.root)}_${mode}_${exportId}.zip`);
    const zipPath = join(exportDir, outputName);
    const trackedFiles = await gitTrackedFiles(workspace.root);
    const skippedFiles: string[] = [];
    const entries: ZipEntryInput[] = [];
    let contentBytes = 0;

    for (const path of trackedFiles) {
      if (entries.length >= maxFiles) {
        skippedFiles.push(path);
        continue;
      }
      if (shouldSkipPath(path)) {
        skippedFiles.push(path);
        continue;
      }
      const absolutePath = join(workspace.root, path);
      const stats = await stat(absolutePath);
      if (!stats.isFile()) continue;
      const data = await readFile(absolutePath);
      contentBytes += data.length;
      if (contentBytes > maxBytes) {
        skippedFiles.push(path);
        continue;
      }
      entries.push({ path, data, mtime: stats.mtime });
    }

    const manifestIncluded = input.includeManifest ?? true;
    if (manifestIncluded) {
      const manifest = buildManifest({ exportId, workspace, mode, entries, skippedFiles, maxBytes, maxFiles });
      entries.push({ path: "manifest.json", data: Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8"), mtime: new Date() });
    }

    const zipBuffer = createDeflateZip(entries);
    if (zipBuffer.length > maxBytes) {
      throw new Error(`Generated ZIP exceeds maxBytes: ${zipBuffer.length} > ${maxBytes}.`);
    }
    await writeFile(zipPath, zipBuffer);
    const sha256 = createHash("sha256").update(zipBuffer).digest("hex");
    const resourceUri = resourceUriForExport(exportId);
    const createdAt = new Date().toISOString();
    const record: WorkspaceZipExportRecord = {
      exportId,
      resourceUri,
      zipPath,
      mode,
      fileCount: entries.length,
      sizeBytes: zipBuffer.length,
      sha256,
      manifestIncluded,
      skippedFiles,
      workspaceId: workspace.id,
      workspaceRoot: workspace.root,
      createdAt,
      result: `Exported ${entries.length} files to ${resourceUri} (${zipBuffer.length} bytes).`,
    };
    this.exports.set(exportId, record);
    return record;
  }

  listExports(): WorkspaceZipExportRecord[] {
    return Array.from(this.exports.values()).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  getExport(exportId: string): WorkspaceZipExportRecord {
    if (!EXPORT_ID_RE.test(exportId)) throw new Error(`Invalid exportId: ${exportId}`);
    const record = this.exports.get(exportId);
    if (!record) throw new Error(`Unknown exportId: ${exportId}. Create it with export_workspace_zip first.`);
    return record;
  }

  async readExportBlob(exportId: string): Promise<string> {
    const record = this.getExport(exportId);
    return (await readFile(record.zipPath)).toString("base64");
  }

  createDownloadUrl(exportId: string, baseUrl: string, input: { ttlSeconds?: number; maxDownloads?: number } = {}): WorkspaceZipDownloadUrlResult {
    this.getExport(exportId);
    const ttlSeconds = input.ttlSeconds ?? DEFAULT_DOWNLOAD_TTL_SECONDS;
    const maxDownloads = input.maxDownloads ?? DEFAULT_DOWNLOAD_MAX_DOWNLOADS;
    if (!Number.isInteger(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > 3600) throw new Error("ttlSeconds must be an integer between 1 and 3600.");
    if (!Number.isInteger(maxDownloads) || maxDownloads < 1 || maxDownloads > 10) throw new Error("maxDownloads must be an integer between 1 and 10.");
    const token = randomBytes(32).toString("base64url");
    const expiresAtMs = Date.now() + ttlSeconds * 1000;
    this.downloads.set(token, { token, exportId, expiresAtMs, maxDownloads, downloads: 0, createdAt: new Date().toISOString() });
    const downloadUrl = new URL(`/devspace-exports/${token}.zip`, baseUrl).toString();
    return {
      exportId,
      downloadUrl,
      token,
      expiresAt: new Date(expiresAtMs).toISOString(),
      ttlSeconds,
      maxDownloads,
      result: `Created temporary ZIP download URL for ${exportId}.`,
    };
  }

  claimDownload(token: string): WorkspaceZipExportRecord {
    if (!DOWNLOAD_TOKEN_RE.test(token)) throw new Error("Invalid download token.");
    const download = this.downloads.get(token);
    if (!download) throw new Error("Unknown download token.");
    if (Date.now() > download.expiresAtMs) {
      this.downloads.delete(token);
      throw new Error("Download token expired.");
    }
    if (download.downloads >= download.maxDownloads) {
      this.downloads.delete(token);
      throw new Error("Download token exhausted.");
    }
    download.downloads += 1;
    if (download.downloads >= download.maxDownloads) this.downloads.delete(token);
    return this.getExport(download.exportId);
  }
}

export function resourceUriForExport(exportId: string): string {
  return `devspace://exports/${exportId}.zip`;
}

export function exportIdFromResourceUri(uri: URL, variables?: Record<string, unknown>): string {
  const variableValue = typeof variables?.exportId === "string" ? variables.exportId : undefined;
  if (variableValue) return variableValue;
  const match = uri.href.match(/^devspace:\/\/exports\/(exp_[0-9]{8}_[0-9]{6}_[A-Za-z0-9]{8})\.zip$/);
  if (!match) throw new Error(`Invalid export resource URI: ${uri.href}`);
  return match[1];
}

async function gitTrackedFiles(root: string): Promise<string[]> {
  const result = await git(root, ["ls-files", "-z"], { maxBuffer: 20 * 1024 * 1024 });
  return result.stdout.split("\0").filter(Boolean).map(normalizeZipPath).filter(Boolean).sort();
}

function buildManifest(input: {
  exportId: string;
  workspace: Workspace;
  mode: WorkspaceZipExportMode;
  entries: ZipEntryInput[];
  skippedFiles: string[];
  maxBytes: number;
  maxFiles: number;
}) {
  return {
    exportId: input.exportId,
    resourceUri: resourceUriForExport(input.exportId),
    createdAt: new Date().toISOString(),
    mode: input.mode,
    workspaceId: input.workspace.id,
    workspaceRootName: basename(input.workspace.root),
    maxBytes: input.maxBytes,
    maxFiles: input.maxFiles,
    fileCount: input.entries.length,
    skippedFiles: input.skippedFiles,
    files: input.entries.map((entry) => ({ path: entry.path, sizeBytes: entry.data.length, sha256: createHash("sha256").update(entry.data).digest("hex") })),
  };
}

function createDeflateZip(entries: ZipEntryInput[]): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  const records: CentralDirectoryRecord[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(normalizeZipPath(entry.path), "utf8");
    const data = entry.data;
    const compressed = deflateRawSync(data);
    const crc32 = crc32Buffer(data);
    const { modTime, modDate } = dosDateTime(entry.mtime ?? new Date());
    const localHeader = Buffer.alloc(30 + name.length);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0x0800, 6);
    localHeader.writeUInt16LE(8, 8);
    localHeader.writeUInt16LE(modTime, 10);
    localHeader.writeUInt16LE(modDate, 12);
    localHeader.writeUInt32LE(crc32, 14);
    localHeader.writeUInt32LE(compressed.length, 18);
    localHeader.writeUInt32LE(data.length, 22);
    localHeader.writeUInt16LE(name.length, 26);
    localHeader.writeUInt16LE(0, 28);
    name.copy(localHeader, 30);
    localParts.push(localHeader, compressed);
    records.push({ path: entry.path, crc32, compressedSize: compressed.length, uncompressedSize: data.length, offset, modTime, modDate });
    offset += localHeader.length + compressed.length;
  }

  const centralStart = offset;
  for (const record of records) {
    const name = Buffer.from(normalizeZipPath(record.path), "utf8");
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

function normalizeZipPath(path: string): string {
  return path.replaceAll("\\", "/").replace(/^\/+/, "");
}

function shouldSkipPath(path: string): boolean {
  const normalized = normalizeZipPath(path);
  if (normalized.includes("../") || normalized.startsWith("/")) return true;
  if (/^\.env($|\.)/.test(basename(normalized))) return true;
  if (/\.(pem|key|p12|pfx)$/i.test(normalized)) return true;
  if (/(^|\/)(id_rsa|id_dsa|id_ecdsa|id_ed25519)$/i.test(normalized)) return true;
  if (/(^|\/)(secret|secrets|credentials)(\.|\/|$)/i.test(normalized)) return true;
  return false;
}

function sanitizeZipName(name: string): string {
  const safe = basename(name).replace(/[^A-Za-z0-9._-]/g, "_");
  return safe.toLowerCase().endsWith(".zip") ? safe : `${safe}.zip`;
}

function makeExportId(now = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  const date = `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}`;
  const time = `${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}`;
  const random = createHash("sha256").update(`${process.pid}:${now.toISOString()}:${Math.random()}`).digest("hex").slice(0, 8);
  return `exp_${date}_${time}_${random}`;
}

function dosDateTime(date: Date): { modTime: number; modDate: number } {
  const year = Math.max(1980, date.getFullYear());
  const modTime = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  const modDate = ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { modTime, modDate };
}

const CRC_TABLE = makeCrcTable();

function crc32Buffer(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function makeCrcTable(): number[] {
  const table: number[] = [];
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
}
