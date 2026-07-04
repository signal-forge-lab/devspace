import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { inflateRawSync } from "node:zlib";
import type { Workspace } from "./workspaces.js";

const DEFAULT_MAX_BYTES = 50 * 1024 * 1024;
const DEFAULT_MAX_FILES = 5_000;
const IMPORT_ID_RE = /^imp_[0-9]{8}_[0-9]{6}_[A-Za-z0-9]{8}$/;
const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_DIRECTORY_SIGNATURE = 0x02014b50;
const LOCAL_FILE_SIGNATURE = 0x04034b50;
const ZIP_METHOD_STORE = 0;
const ZIP_METHOD_DEFLATE = 8;
const IMPORT_METADATA_FILE = "import.json";
const SOURCE_ZIP_FILE = "source.zip";

export const ZIP_IMPORT_MIME_TYPE = "application/zip";

export interface UploadedFileInfo {
  originalName: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
}

export interface ProbeImportFileResult extends UploadedFileInfo, Record<string, unknown> {
  result: string;
}

export interface ProbeImportArgumentShapeResult extends Record<string, unknown> {
  result: string;
  valueKind: string;
  constructorName?: string;
  hasArrayBuffer: boolean;
  hasName: boolean;
  hasType: boolean;
  hasSize: boolean;
  stringKind?: string;
  stringLength?: number;
  name?: string;
  mimeType?: string;
  sizeBytes?: number;
  keys: string[];
}

export interface ImportZipFileResult extends UploadedFileInfo, Record<string, unknown> {
  importId: string;
  importDir: string;
  sourceZipPath: string;
  entryCount: number;
  totalUncompressedBytes: number;
  manifestPresent: boolean;
  result: string;
}

export interface ExtractImportedZipResult extends Record<string, unknown> {
  workspaceId: string;
  importId: string;
  extractDir: string;
  fileCount: number;
  totalBytes: number;
  files: string[];
  result: string;
}

export type UploadedFileLike = File | {
  name?: string;
  type?: string;
  size?: number;
  arrayBuffer(): Promise<ArrayBuffer>;
};

export type ImportFileSource = UploadedFileLike | string;

interface ImportedZipRecord extends ImportZipFileResult {
  workspaceId: string;
  workspaceRoot: string;
  createdAt: string;
}

interface ZipEntryRecord {
  path: string;
  method: number;
  crc32: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
}

export class WorkspaceZipImportStore {
  private readonly imports = new Map<string, ImportedZipRecord>();

  probeImportArgumentShape(value: unknown): ProbeImportArgumentShapeResult {
    return describeImportArgument(value);
  }

  async probeImportFile(source: ImportFileSource, input: { maxBytes?: number } = {}): Promise<ProbeImportFileResult> {
    const uploaded = await readImportSource(source, input.maxBytes);
    return {
      ...uploaded.info,
      result: `Received file ${uploaded.info.originalName} (${uploaded.info.sizeBytes} bytes).`,
    };
  }

  async importZipFile(
    workspace: Workspace,
    source: ImportFileSource,
    input: { expectedSha256?: string; maxBytes?: number; maxFiles?: number } = {},
  ): Promise<ImportZipFileResult> {
    const uploaded = await readImportSource(source, input.maxBytes);
    if (input.expectedSha256 && uploaded.info.sha256 !== input.expectedSha256) {
      throw new Error(`sha256 mismatch: ${uploaded.info.sha256} != ${input.expectedSha256}.`);
    }
    const maxFiles = input.maxFiles ?? DEFAULT_MAX_FILES;
    const entries = inspectZip(uploaded.data, { maxFiles, maxBytes: input.maxBytes });
    const importId = makeImportId();
    const importDir = importDirFor(workspace, importId);
    await mkdir(importDir, { recursive: true });
    const sourceZipPath = join(importDir, SOURCE_ZIP_FILE);
    await writeFile(sourceZipPath, uploaded.data, { flag: "wx" });
    const manifestPresent = entries.some((entry) => entry.path === "manifest.json");
    const totalUncompressedBytes = entries.reduce((sum, entry) => sum + entry.uncompressedSize, 0);
    const createdAt = new Date().toISOString();
    const result: ImportedZipRecord = {
      ...uploaded.info,
      importId,
      importDir,
      sourceZipPath,
      entryCount: entries.length,
      totalUncompressedBytes,
      manifestPresent,
      workspaceId: workspace.id,
      workspaceRoot: workspace.root,
      createdAt,
      result: `Imported ZIP ${uploaded.info.originalName} as ${importId} (${entries.length} entries).`,
    };
    await writeFile(join(importDir, IMPORT_METADATA_FILE), `${JSON.stringify(result, null, 2)}\n`, { flag: "wx" });
    this.imports.set(importId, result);
    return result;
  }

  async extractImportedZip(
    workspace: Workspace,
    importId: string,
    input: { maxBytes?: number; maxFiles?: number } = {},
  ): Promise<ExtractImportedZipResult> {
    const record = await this.getImportForWorkspace(workspace, importId);
    const zip = await readFile(record.sourceZipPath);
    const entries = inspectZip(zip, { maxFiles: input.maxFiles, maxBytes: input.maxBytes });
    const extractDir = join(record.importDir, "extracted");
    await mkdir(extractDir, { recursive: true });
    const files: string[] = [];
    let totalBytes = 0;
    for (const entry of entries) {
      const data = extractZipEntry(zip, entry);
      totalBytes += data.length;
      if (input.maxBytes && totalBytes > input.maxBytes) {
        throw new Error(`Extracted content exceeds maxBytes: ${totalBytes} > ${input.maxBytes}.`);
      }
      const outputPath = join(extractDir, entry.path);
      await mkdir(dirname(outputPath), { recursive: true });
      await writeFile(outputPath, data, { flag: "wx" });
      files.push(entry.path);
    }
    return {
      workspaceId: workspace.id,
      importId,
      extractDir,
      fileCount: files.length,
      totalBytes,
      files: files.slice(0, 50),
      result: `Extracted ${files.length} files from ${importId} to ${extractDir}.`,
    };
  }

  getImport(importId: string): ImportedZipRecord {
    if (!IMPORT_ID_RE.test(importId)) throw new Error(`Invalid importId: ${importId}`);
    const record = this.imports.get(importId);
    if (!record) throw new Error(`Unknown importId: ${importId}. Create it with import_zip_file first.`);
    return record;
  }

  private async getImportForWorkspace(workspace: Workspace, importId: string): Promise<ImportedZipRecord> {
    if (!IMPORT_ID_RE.test(importId)) throw new Error(`Invalid importId: ${importId}`);
    const cached = this.imports.get(importId);
    if (cached) return validateImportRecordForWorkspace(workspace, cached);
    const metadataPath = join(importDirFor(workspace, importId), IMPORT_METADATA_FILE);
    const parsed = JSON.parse(await readFile(metadataPath, "utf8")) as ImportedZipRecord;
    const record = validateImportRecordForWorkspace(workspace, parsed);
    await stat(record.sourceZipPath);
    this.imports.set(importId, record);
    return record;
  }
}

async function readImportSource(source: ImportFileSource, maxBytes = DEFAULT_MAX_BYTES): Promise<{ data: Buffer; info: UploadedFileInfo }> {
  if (typeof source === "string") return readStringSource(source, maxBytes);
  if (!source || typeof source.arrayBuffer !== "function") {
    const shape = describeImportArgument(source);
    throw new Error(`Expected an MCP file parameter with arrayBuffer() or an http(s) URL string. Received ${shape.valueKind}.`);
  }
  return readUploadedFile(source, maxBytes);
}

async function readUploadedFile(file: UploadedFileLike, maxBytes = DEFAULT_MAX_BYTES): Promise<{ data: Buffer; info: UploadedFileInfo }> {
  const data = Buffer.from(await file.arrayBuffer());
  if (data.length > maxBytes) throw new Error(`Uploaded file exceeds maxBytes: ${data.length} > ${maxBytes}.`);
  const originalName = sanitizeOriginalName(file.name || "uploaded.zip");
  const mimeType = file.type || ZIP_IMPORT_MIME_TYPE;
  const sizeBytes = typeof file.size === "number" ? file.size : data.length;
  if (sizeBytes !== data.length) throw new Error(`Uploaded file size mismatch: ${sizeBytes} != ${data.length}.`);
  return {
    data,
    info: {
      originalName,
      mimeType,
      sizeBytes: data.length,
      sha256: createHash("sha256").update(data).digest("hex"),
    },
  };
}

async function readStringSource(source: string, maxBytes: number): Promise<{ data: Buffer; info: UploadedFileInfo }> {
  const trimmed = source.trim();
  if (!/^https?:\/\//i.test(trimmed)) {
    const stringKind = classifyStringSource(trimmed);
    throw new Error(
      `Received ${stringKind} string instead of a File object or http(s) URL. ` +
        "The MCP host may not have rewritten the uploaded file argument. Use probe_import_file_arg_shape for diagnostics.",
    );
  }
  const url = new URL(trimmed);
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok) throw new Error(`Failed to fetch import source URL: HTTP ${response.status}.`);
  const contentLength = response.headers.get("content-length");
  if (contentLength && Number(contentLength) > maxBytes) {
    throw new Error(`Import source exceeds maxBytes: ${contentLength} > ${maxBytes}.`);
  }
  const data = Buffer.from(await response.arrayBuffer());
  if (data.length > maxBytes) throw new Error(`Import source exceeds maxBytes: ${data.length} > ${maxBytes}.`);
  const pathName = decodeURIComponent(url.pathname.split("/").filter(Boolean).pop() || "uploaded.zip");
  const contentType = response.headers.get("content-type")?.split(";")[0]?.trim() || ZIP_IMPORT_MIME_TYPE;
  return {
    data,
    info: {
      originalName: sanitizeOriginalName(pathName),
      mimeType: contentType,
      sizeBytes: data.length,
      sha256: createHash("sha256").update(data).digest("hex"),
    },
  };
}

function describeImportArgument(value: unknown): ProbeImportArgumentShapeResult {
  const valueKind = value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
  const asRecord = value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
  const keys = asRecord ? Object.keys(asRecord).slice(0, 30) : [];
  const result: ProbeImportArgumentShapeResult = {
    result: "Inspected import file argument shape without reading file bytes.",
    valueKind,
    constructorName: value && typeof value === "object" ? value.constructor?.name : undefined,
    hasArrayBuffer: !!asRecord && typeof asRecord.arrayBuffer === "function",
    hasName: !!asRecord && typeof asRecord.name === "string",
    hasType: !!asRecord && typeof asRecord.type === "string",
    hasSize: !!asRecord && typeof asRecord.size === "number",
    keys,
  };
  if (typeof value === "string") {
    result.stringKind = classifyStringSource(value);
    result.stringLength = value.length;
  }
  if (asRecord && typeof asRecord.name === "string") result.name = sanitizeOriginalName(asRecord.name);
  if (asRecord && typeof asRecord.type === "string") result.mimeType = asRecord.type;
  if (asRecord && typeof asRecord.size === "number") result.sizeBytes = asRecord.size;
  return result;
}

function classifyStringSource(value: string): string {
  if (/^https?:\/\//i.test(value)) return "http_url";
  if (/^file:\/\//i.test(value)) return "file_url";
  if (/^\//.test(value)) return "unix_path";
  if (/^[A-Za-z]:[\\/]/.test(value)) return "windows_path";
  return "plain_string";
}

function inspectZip(zip: Buffer, input: { maxFiles?: number; maxBytes?: number } = {}): ZipEntryRecord[] {
  const entries = readCentralDirectory(zip);
  const maxFiles = input.maxFiles ?? DEFAULT_MAX_FILES;
  if (entries.length > maxFiles) throw new Error(`ZIP file count exceeds maxFiles: ${entries.length} > ${maxFiles}.`);
  const totalBytes = entries.reduce((sum, entry) => sum + entry.uncompressedSize, 0);
  if (input.maxBytes && totalBytes > input.maxBytes) {
    throw new Error(`ZIP uncompressed content exceeds maxBytes: ${totalBytes} > ${input.maxBytes}.`);
  }
  return entries;
}

function readCentralDirectory(zip: Buffer): ZipEntryRecord[] {
  const eocdOffset = findEndOfCentralDirectory(zip);
  const totalEntries = zip.readUInt16LE(eocdOffset + 10);
  const centralDirectorySize = zip.readUInt32LE(eocdOffset + 12);
  const centralDirectoryOffset = zip.readUInt32LE(eocdOffset + 16);
  if (centralDirectoryOffset + centralDirectorySize > zip.length) throw new Error("Invalid ZIP central directory range.");

  const entries: ZipEntryRecord[] = [];
  let seenCentralEntries = 0;
  let offset = centralDirectoryOffset;
  while (offset < centralDirectoryOffset + centralDirectorySize) {
    if (zip.readUInt32LE(offset) !== CENTRAL_DIRECTORY_SIGNATURE) throw new Error("Invalid ZIP central directory entry.");
    seenCentralEntries += 1;
    const method = zip.readUInt16LE(offset + 10);
    const crc32 = zip.readUInt32LE(offset + 16);
    const compressedSize = zip.readUInt32LE(offset + 20);
    const uncompressedSize = zip.readUInt32LE(offset + 24);
    const fileNameLength = zip.readUInt16LE(offset + 28);
    const extraLength = zip.readUInt16LE(offset + 30);
    const commentLength = zip.readUInt16LE(offset + 32);
    const localHeaderOffset = zip.readUInt32LE(offset + 42);
    const nameStart = offset + 46;
    const nameEnd = nameStart + fileNameLength;
    const rawPath = zip.subarray(nameStart, nameEnd).toString("utf8");
    const path = safeZipPath(rawPath, { allowDirectory: true });
    if (!path.endsWith("/")) {
      if (method !== ZIP_METHOD_STORE && method !== ZIP_METHOD_DEFLATE) {
        throw new Error(`Unsupported ZIP compression method for ${path}: ${method}.`);
      }
      entries.push({ path, method, crc32, compressedSize, uncompressedSize, localHeaderOffset });
    }
    offset = nameEnd + extraLength + commentLength;
  }
  if (seenCentralEntries !== totalEntries) {
    throw new Error(`ZIP central directory entry count mismatch: ${seenCentralEntries} != ${totalEntries}.`);
  }
  return entries;
}

function extractZipEntry(zip: Buffer, entry: ZipEntryRecord): Buffer {
  const offset = entry.localHeaderOffset;
  if (zip.readUInt32LE(offset) !== LOCAL_FILE_SIGNATURE) throw new Error(`Invalid local header for ${entry.path}.`);
  const fileNameLength = zip.readUInt16LE(offset + 26);
  const extraLength = zip.readUInt16LE(offset + 28);
  const nameStart = offset + 30;
  const nameEnd = nameStart + fileNameLength;
  const localPath = safeZipPath(zip.subarray(nameStart, nameEnd).toString("utf8"));
  if (localPath !== entry.path) throw new Error(`ZIP local header path mismatch for ${entry.path}.`);
  const dataStart = nameEnd + extraLength;
  const dataEnd = dataStart + entry.compressedSize;
  if (dataEnd > zip.length) throw new Error(`Invalid compressed data range for ${entry.path}.`);
  const compressed = zip.subarray(dataStart, dataEnd);
  const data = entry.method === ZIP_METHOD_STORE ? Buffer.from(compressed) : inflateRawSync(compressed);
  if (data.length !== entry.uncompressedSize) {
    throw new Error(`Uncompressed size mismatch for ${entry.path}: ${data.length} != ${entry.uncompressedSize}.`);
  }
  const crc32 = crc32Buffer(data);
  if (crc32 !== entry.crc32) throw new Error(`CRC32 mismatch for ${entry.path}.`);
  return data;
}

function findEndOfCentralDirectory(zip: Buffer): number {
  const maxComment = 0xffff;
  const minOffset = Math.max(0, zip.length - (maxComment + 22));
  for (let offset = zip.length - 22; offset >= minOffset; offset -= 1) {
    if (zip.readUInt32LE(offset) === EOCD_SIGNATURE) return offset;
  }
  throw new Error("Invalid ZIP: end of central directory not found.");
}

function safeZipPath(path: string, options: { allowDirectory?: boolean } = {}): string {
  const normalized = path.replace(/\\/g, "/");
  if (!normalized || normalized.startsWith("/") || /^[A-Za-z]:/.test(normalized)) throw new Error(`Unsafe ZIP path: ${path}`);
  const isDirectory = normalized.endsWith("/");
  const withoutTrailingSlash = isDirectory ? normalized.slice(0, -1) : normalized;
  if (!withoutTrailingSlash) throw new Error(`Unsafe ZIP path: ${path}`);
  const parts = withoutTrailingSlash.split("/");
  if (parts.some((part) => part === "" || part === "." || part === "..")) throw new Error(`Unsafe ZIP path: ${path}`);
  if (isDirectory && !options.allowDirectory) throw new Error(`Unexpected ZIP directory path: ${path}`);
  return isDirectory ? `${withoutTrailingSlash}/` : withoutTrailingSlash;
}

function sanitizeOriginalName(name: string): string {
  const fileName = name.replace(/\\/g, "/").split("/").pop() || "uploaded.zip";
  const safe = fileName.replace(/[^A-Za-z0-9._-]/g, "_");
  return safe || "uploaded.zip";
}

function importDirFor(workspace: Workspace, importId: string): string {
  if (!IMPORT_ID_RE.test(importId)) throw new Error(`Invalid importId: ${importId}`);
  return join(workspace.root, ".devspace", "imports", importId);
}

function validateImportRecordForWorkspace(workspace: Workspace, record: ImportedZipRecord): ImportedZipRecord {
  if (!record || record.importId === undefined) throw new Error("Invalid ZIP import metadata.");
  if (!IMPORT_ID_RE.test(record.importId)) throw new Error(`Invalid importId in metadata: ${record.importId}`);
  if (record.workspaceId !== workspace.id) throw new Error(`Import ${record.importId} belongs to a different workspace.`);
  const expectedDir = importDirFor(workspace, record.importId);
  if (record.importDir !== expectedDir) throw new Error(`Import metadata path mismatch for ${record.importId}.`);
  const expectedSourceZipPath = join(expectedDir, SOURCE_ZIP_FILE);
  if (record.sourceZipPath !== expectedSourceZipPath) throw new Error(`Import source path mismatch for ${record.importId}.`);
  return record;
}

function makeImportId(): string {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/T/, "_").slice(0, 15);
  return `imp_${stamp}_${randomBytes(4).toString("hex")}`;
}

function crc32Buffer(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc = CRC32_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

const CRC32_TABLE = new Uint32Array(256).map((_, index) => {
  let crc = index;
  for (let bit = 0; bit < 8; bit += 1) {
    crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  }
  return crc >>> 0;
});
