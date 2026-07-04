import { createHash, randomBytes } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { git } from "./git.js";
import type { Workspace } from "./workspaces.js";

const DEFAULT_MAX_FILES = 5_000;
const DEFAULT_MAX_PREVIEW_FILES = 200;
const DEFAULT_MAX_TOTAL_CHARACTERS = 120_000;
const DEFAULT_MAX_RANGES = 80;
const DEFAULT_MAX_LINES_PER_RANGE = 2_000;
const INDEX_ID_RE = /^idx_[0-9]{8}_[0-9]{6}_[A-Za-z0-9]{8}$/;

export type WorkspaceIndexMode = "git_tracked";

export interface CreateWorkspaceIndexInput {
  mode?: WorkspaceIndexMode;
  includeExtensions?: string[];
  pathPrefixes?: string[];
  includePaths?: string[];
  maxFiles?: number;
  maxPreviewFiles?: number;
  reuse?: boolean;
  refresh?: boolean;
  includePreview?: boolean;
}

export interface WorkspaceIndexEntry extends Record<string, unknown> {
  number: number;
  path: string;
  sizeBytes: number;
  mtimeMs?: number;
}

export interface WorkspaceIndexResult extends Record<string, unknown> {
  indexId: string;
  workspaceId: string;
  mode: WorkspaceIndexMode;
  fileCount: number;
  previewCount: number;
  truncated: boolean;
  pathHash: string;
  fingerprintHash: string;
  cacheKey: string;
  reused: boolean;
  source: "created" | "cache";
  staleReason?: string | null;
  createdAt: string;
  lastUsedAt: string;
  entries: WorkspaceIndexEntry[];
  result: string;
}

interface WorkspaceIndexRecord {
  indexId: string;
  workspaceId: string;
  workspaceRoot: string;
  createdAt: string;
  lastUsedAt: string;
  mode: WorkspaceIndexMode;
  fileCount: number;
  truncated: boolean;
  pathHash: string;
  fingerprintHash: string;
  cacheKey: string;
  allEntries: WorkspaceIndexEntry[];
}

export interface ReadIndexRangeInput {
  number: number;
  startLine: number;
  endLine: number;
}

export interface ReadIndexRangesInput {
  indexId: string;
  spec?: string;
  ranges?: ReadIndexRangeInput[];
  maxTotalCharacters?: number;
  maxRanges?: number;
  maxLinesPerRange?: number;
}

export interface ResolveIndexPathsInput {
  indexId: string;
  numbers?: number[];
}

export interface ReadIndexRangeResult extends Record<string, unknown> {
  number: number;
  path: string;
  startLine: number;
  endLine: number;
  ok: boolean;
  content?: string;
  error?: string;
  characters?: number;
  lines?: number;
  limited: boolean;
}

export interface ReadIndexRangesResult extends Record<string, unknown> {
  indexId: string;
  ranges: ReadIndexRangeResult[];
  summary: {
    requested: number;
    succeeded: number;
    failed: number;
    characters: number;
    truncated: boolean;
  };
  result: string;
}

interface ParsedRange {
  number: number;
  startLine: number;
  endLine: number;
}

export class WorkspaceIndexStore {
  private readonly indexes = new Map<string, WorkspaceIndexRecord>();
  private readonly indexIdsByCacheKey = new Map<string, string>();

  async createWorkspaceIndex(workspace: Workspace, input: CreateWorkspaceIndexInput = {}): Promise<WorkspaceIndexResult> {
    const mode = input.mode ?? "git_tracked";
    if (mode !== "git_tracked") throw new Error(`Unsupported workspace index mode: ${mode}`);
    const maxFiles = input.maxFiles ?? DEFAULT_MAX_FILES;
    const maxPreviewFiles = input.maxPreviewFiles ?? DEFAULT_MAX_PREVIEW_FILES;
    const reuse = input.reuse ?? true;
    const refresh = input.refresh ?? false;
    if (!Number.isInteger(maxFiles) || maxFiles < 1) throw new Error("maxFiles must be a positive integer.");
    if (!Number.isInteger(maxPreviewFiles) || maxPreviewFiles < 1) throw new Error("maxPreviewFiles must be a positive integer.");

    const includeExtensions = normalizeExtensions(input.includeExtensions);
    const pathPrefixes = normalizePathFilters(input.pathPrefixes);
    const includePaths = normalizePathFilters(input.includePaths);
    const entries = await buildIndexEntries(workspace, { mode, includeExtensions, pathPrefixes, includePaths, maxFiles });
    const pathHash = hashText(entries.map((entry) => entry.path).join("\n"));
    const fingerprintHash = hashText(entries.map((entry) => `${entry.path}\0${entry.sizeBytes}\0${entry.mtimeMs ?? ""}`).join("\n"));
    const cacheKey = hashText(JSON.stringify({
      workspaceRoot: workspace.root,
      mode,
      includeExtensions,
      pathPrefixes,
      includePaths,
      maxFiles,
      pathHash,
      fingerprintHash,
    }));

    if (reuse && !refresh) {
      const cached = this.findReusableIndex(workspace, cacheKey);
      if (cached) {
        cached.lastUsedAt = new Date().toISOString();
        return publicIndexResult(cached, {
          reused: true,
          source: "cache",
          staleReason: null,
          includePreview: input.includePreview ?? false,
          maxPreviewFiles,
        });
      }
    }

    const now = new Date().toISOString();
    const indexId = makeIndexId();
    const record: WorkspaceIndexRecord = {
      indexId,
      workspaceId: workspace.id,
      workspaceRoot: workspace.root,
      createdAt: now,
      lastUsedAt: now,
      mode,
      fileCount: entries.length,
      truncated: entries.length > maxPreviewFiles,
      pathHash,
      fingerprintHash,
      cacheKey,
      allEntries: entries,
    };
    this.indexes.set(indexId, record);
    this.indexIdsByCacheKey.set(cacheKey, indexId);
    return publicIndexResult(record, {
      reused: false,
      source: "created",
      staleReason: refresh ? "refresh_requested" : "cache_miss",
      includePreview: input.includePreview ?? true,
      maxPreviewFiles,
    });
  }

  resolveIndexPaths(workspace: Workspace, input: ResolveIndexPathsInput): string[] {
    return this.resolveIndexEntries(workspace, input).map((entry) => entry.path);
  }

  resolveIndexEntries(workspace: Workspace, input: ResolveIndexPathsInput): WorkspaceIndexEntry[] {
    const record = this.getIndex(input.indexId);
    if (record.workspaceId !== workspace.id || record.workspaceRoot !== workspace.root) {
      throw new Error(`Index ${input.indexId} belongs to a different workspace.`);
    }
    const numbers = input.numbers ?? record.allEntries.map((entry) => entry.number);
    const entries: WorkspaceIndexEntry[] = [];
    const seen = new Set<string>();
    for (const number of numbers) {
      if (!Number.isInteger(number) || number < 1) throw new Error(`Invalid index file number: ${number}`);
      const entry = record.allEntries[number - 1];
      if (!entry) throw new Error(`Unknown file index: ${number}`);
      if (seen.has(entry.path)) continue;
      seen.add(entry.path);
      entries.push(entry);
    }
    return entries;
  }

  async readIndexRanges(workspace: Workspace, input: ReadIndexRangesInput): Promise<ReadIndexRangesResult> {
    const record = this.getIndex(input.indexId);
    if (record.workspaceId !== workspace.id || record.workspaceRoot !== workspace.root) {
      throw new Error(`Index ${input.indexId} belongs to a different workspace.`);
    }
    const maxRanges = input.maxRanges ?? DEFAULT_MAX_RANGES;
    const maxLinesPerRange = input.maxLinesPerRange ?? DEFAULT_MAX_LINES_PER_RANGE;
    const maxTotalCharacters = input.maxTotalCharacters ?? DEFAULT_MAX_TOTAL_CHARACTERS;
    const parsed = normalizeReadIndexRangesInput(input);
    if (parsed.length > maxRanges) throw new Error(`Range count exceeds maxRanges: ${parsed.length} > ${maxRanges}.`);

    const ranges: ReadIndexRangeResult[] = [];
    let characters = 0;
    let truncated = false;

    for (const range of parsed) {
      const entry = record.allEntries[range.number - 1];
      if (!entry) {
        ranges.push({ number: range.number, path: "", startLine: range.startLine, endLine: range.endLine, ok: false, error: `Unknown file index: ${range.number}`, limited: false });
        continue;
      }
      if (range.endLine < range.startLine) {
        ranges.push({ number: range.number, path: entry.path, startLine: range.startLine, endLine: range.endLine, ok: false, error: "Range end must be greater than or equal to range start.", limited: false });
        continue;
      }
      if (range.endLine - range.startLine + 1 > maxLinesPerRange) {
        ranges.push({ number: range.number, path: entry.path, startLine: range.startLine, endLine: range.endLine, ok: false, error: `Range exceeds maxLinesPerRange: ${range.endLine - range.startLine + 1} > ${maxLinesPerRange}.`, limited: false });
        continue;
      }
      const remaining = Math.max(0, maxTotalCharacters - characters);
      if (remaining === 0) {
        truncated = true;
        ranges.push({ number: range.number, path: entry.path, startLine: range.startLine, endLine: range.endLine, ok: true, content: "", characters: 0, lines: 0, limited: true });
        continue;
      }
      try {
        const text = await readFile(join(workspace.root, entry.path), "utf8");
        const lines = splitLines(text);
        const selected = lines.slice(range.startLine - 1, range.endLine).join("\n");
        const content = selected.slice(0, remaining);
        const limited = content.length < selected.length;
        truncated ||= limited;
        characters += content.length;
        ranges.push({
          number: range.number,
          path: entry.path,
          startLine: range.startLine,
          endLine: range.endLine,
          ok: true,
          content,
          characters: content.length,
          lines: contentLineCount(content),
          limited,
        });
      } catch (error) {
        ranges.push({ number: range.number, path: entry.path, startLine: range.startLine, endLine: range.endLine, ok: false, error: errorMessage(error), limited: false });
      }
    }

    const succeeded = ranges.filter((range) => range.ok).length;
    const failed = ranges.length - succeeded;
    const summary = { requested: ranges.length, succeeded, failed, characters, truncated };
    return {
      indexId: input.indexId,
      ranges,
      summary,
      result: formatReadRangesResult(input.indexId, ranges),
    };
  }

  private findReusableIndex(workspace: Workspace, cacheKey: string): WorkspaceIndexRecord | undefined {
    const indexId = this.indexIdsByCacheKey.get(cacheKey);
    if (!indexId) return undefined;
    const record = this.indexes.get(indexId);
    if (!record) {
      this.indexIdsByCacheKey.delete(cacheKey);
      return undefined;
    }
    if (record.workspaceId !== workspace.id || record.workspaceRoot !== workspace.root) return undefined;
    return record;
  }

  private getIndex(indexId: string): WorkspaceIndexRecord {
    if (!INDEX_ID_RE.test(indexId)) throw new Error(`Invalid indexId: ${indexId}`);
    const record = this.indexes.get(indexId);
    if (!record) throw new Error(`Unknown indexId: ${indexId}. Create it with create_workspace_index first.`);
    return record;
  }
}

interface NormalizedIndexBuildInput {
  mode: WorkspaceIndexMode;
  includeExtensions: string[];
  pathPrefixes: string[];
  includePaths: string[];
  maxFiles: number;
}

async function buildIndexEntries(workspace: Workspace, input: NormalizedIndexBuildInput): Promise<WorkspaceIndexEntry[]> {
  const trackedFiles = await gitTrackedFiles(workspace.root);
  const selectedPaths: string[] = [];

  for (const path of trackedFiles) {
    if (selectedPaths.length >= input.maxFiles) break;
    if (shouldSkipPath(path)) continue;
    if (input.includePaths.length > 0 && !input.includePaths.includes(path)) continue;
    if (input.pathPrefixes.length > 0 && !input.pathPrefixes.some((prefix) => path === prefix || path.startsWith(`${prefix}/`))) continue;
    if (input.includeExtensions.length > 0 && !input.includeExtensions.some((extension) => path.endsWith(extension))) continue;
    selectedPaths.push(path);
  }

  const entries: WorkspaceIndexEntry[] = [];
  for (let i = 0; i < selectedPaths.length; i += 1) {
    const path = selectedPaths[i]!;
    const stats = await stat(join(workspace.root, path));
    if (!stats.isFile()) continue;
    entries.push({ number: entries.length + 1, path, sizeBytes: stats.size, mtimeMs: Math.trunc(stats.mtimeMs) });
  }
  return entries;
}

function hashText(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

async function gitTrackedFiles(root: string): Promise<string[]> {
  const output = await git(root, ["ls-files", "-z"], { maxBuffer: 50 * 1024 * 1024 });
  return output.stdout.split("\0").filter(Boolean).map((path) => normalizeWorkspacePath(path));
}

function normalizeReadIndexRangesInput(input: ReadIndexRangesInput): ParsedRange[] {
  const parsed = [
    ...parseStructuredRanges(input.ranges),
    ...parseRangeSpec(input.spec),
  ];
  if (parsed.length === 0) {
    throw new Error("read_index_ranges requires either spec or ranges. Use spec like '1;L2-L3' / '1:2-3', or ranges like [{ number: 1, startLine: 2, endLine: 3 }].");
  }
  return parsed;
}

function parseStructuredRanges(ranges: ReadIndexRangeInput[] | undefined): ParsedRange[] {
  return (ranges ?? []).map((range, index) => {
    const number = normalizePositiveInteger(range.number, `ranges[${index}].number`);
    const startLine = normalizePositiveInteger(range.startLine, `ranges[${index}].startLine`);
    const endLine = normalizePositiveInteger(range.endLine, `ranges[${index}].endLine`);
    return { number, startLine, endLine };
  });
}

function parseRangeSpec(spec: string | undefined): ParsedRange[] {
  return (spec ?? "").split(",").map((part) => part.trim()).filter(Boolean).map((part) => {
    const match = /^(\d+)\s*[;:]\s*L?(\d+)\s*-\s*L?(\d+)$/i.exec(part);
    if (!match) throw new Error(`Invalid range spec part: ${part}. Expected '1;L2-L3', '1:2-3', or use structured ranges.`);
    return { number: Number(match[1]), startLine: Number(match[2]), endLine: Number(match[3]) };
  });
}

function normalizePositiveInteger(value: number, label: string): number {
  if (!Number.isInteger(value) || value < 1) throw new Error(`${label} must be a positive integer.`);
  return value;
}

function normalizeExtensions(values: string[] | undefined): string[] {
  return Array.from(new Set((values ?? []).map((value) => value.trim()).filter(Boolean).map((value) => value.startsWith(".") ? value : `.${value}`)));
}

function normalizePathFilters(values: string[] | undefined): string[] {
  return Array.from(new Set((values ?? []).map((value) => normalizeWorkspacePath(value)).filter(Boolean)));
}

function normalizeWorkspacePath(path: string): string {
  const normalized = path.replace(/\\/g, "/").replace(/^\.\//, "");
  if (!normalized || normalized.startsWith("/") || /^[A-Za-z]:/.test(normalized)) throw new Error(`Unsafe workspace path: ${path}`);
  const parts = normalized.split("/");
  if (parts.some((part) => part === "" || part === "." || part === "..")) throw new Error(`Unsafe workspace path: ${path}`);
  return normalized;
}

function shouldSkipPath(path: string): boolean {
  return path === ".env" || path.startsWith(".env.") || path.startsWith(".devspace/") || path.includes("/node_modules/") || path.includes("/dist/") || path.includes("/build/");
}

function splitLines(text: string): string[] {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
}

function contentLineCount(content: string): number {
  if (content.length === 0) return 0;
  return content.endsWith("\n") ? content.slice(0, -1).split("\n").length : content.split("\n").length;
}

function formatIndexResult(indexId: string, entries: WorkspaceIndexEntry[], previewCount: number, source: "created" | "cache"): string {
  const verb = source === "cache" ? "Reused" : "Created";
  const shown = entries.slice(0, previewCount).map((entry) => `${entry.number}\t${entry.path}\t${entry.sizeBytes} bytes`).join("\n");
  const suffix = previewCount < entries.length ? `\n[truncated: ${entries.length - previewCount} more files]` : "";
  return [`${verb} workspace index ${indexId} (${entries.length} files).`, shown, suffix].filter(Boolean).join("\n");
}

function formatReadRangesResult(indexId: string, ranges: ReadIndexRangeResult[]): string {
  return [`# index ${indexId}`, ...ranges.map((range) => {
    const heading = `# [${range.number}] ${range.path || "<unknown>"} L${range.startLine}-L${range.endLine}`;
    if (!range.ok) return `${heading}\n[error] ${range.error ?? "Unknown error"}`;
    return `${heading}\n${range.content ?? ""}${range.limited ? "\n[limited]" : ""}`;
  })].join("\n\n");
}

function publicIndexResult(
  record: WorkspaceIndexRecord,
  options: { reused: boolean; source: "created" | "cache"; staleReason: string | null; includePreview: boolean; maxPreviewFiles: number },
): WorkspaceIndexResult {
  const previewCount = options.includePreview ? Math.min(record.allEntries.length, options.maxPreviewFiles) : 0;
  const entries = record.allEntries.slice(0, previewCount).map(({ mtimeMs: _mtimeMs, ...entry }) => entry);
  return {
    indexId: record.indexId,
    workspaceId: record.workspaceId,
    mode: record.mode,
    fileCount: record.fileCount,
    previewCount,
    truncated: previewCount < record.allEntries.length,
    pathHash: record.pathHash,
    fingerprintHash: record.fingerprintHash,
    cacheKey: record.cacheKey,
    reused: options.reused,
    source: options.source,
    staleReason: options.staleReason,
    createdAt: record.createdAt,
    lastUsedAt: record.lastUsedAt,
    entries,
    result: formatIndexResult(record.indexId, record.allEntries, previewCount, options.source),
  };
}

function makeIndexId(): string {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/T/, "_").slice(0, 15);
  return `idx_${stamp}_${randomBytes(4).toString("hex")}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
