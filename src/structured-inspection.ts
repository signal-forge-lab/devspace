import { opendir, readFile, stat } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { basename, extname, join, relative, resolve, sep } from "node:path";
import { resolveAllowedPath } from "./roots.js";
import type { Workspace } from "./workspaces.js";

export const DEFAULT_GREP_CONTEXT_LINES = 2;
export const MAX_GREP_CONTEXT_LINES = 10;
export const DEFAULT_GREP_MAX_MATCHES = 50;
export const MAX_GREP_MAX_MATCHES = 500;
export const DEFAULT_GREP_MAX_FILES = 1_000;
export const MAX_GREP_MAX_FILES = 10_000;
export const DEFAULT_GREP_MAX_FILE_BYTES = 1_000_000;
export const MAX_GREP_MAX_FILE_BYTES = 5_000_000;
export const DEFAULT_OUTLINE_MAX_SYMBOLS = 200;
export const MAX_OUTLINE_MAX_SYMBOLS = 1_000;

const SKIPPED_DIRECTORIES = new Set([
  ".git",
  ".hg",
  ".svn",
  ".cache",
  ".devspace",
  ".next",
  ".turbo",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "releases",
]);

const DEFAULT_TEXT_EXTENSIONS = new Set([
  ".c",
  ".cc",
  ".cfg",
  ".cpp",
  ".cs",
  ".css",
  ".csv",
  ".cts",
  ".go",
  ".h",
  ".hpp",
  ".html",
  ".ini",
  ".java",
  ".js",
  ".json",
  ".jsonc",
  ".jsonl",
  ".jsx",
  ".log",
  ".mjs",
  ".md",
  ".mdx",
  ".mts",
  ".py",
  ".rs",
  ".sh",
  ".sql",
  ".toml",
  ".ts",
  ".tsx",
  ".txt",
  ".xml",
  ".yaml",
  ".yml",
]);

export interface GrepContextInput {
  query: string;
  path?: string;
  regex?: boolean;
  caseSensitive?: boolean;
  contextLines?: number;
  maxMatches?: number;
  maxFiles?: number;
  maxFileBytes?: number;
  includeExtensions?: string[];
}

export interface GrepContextLine {
  line: number;
  text: string;
  match: boolean;
}

export interface GrepContextMatch {
  path: string;
  line: number;
  column: number;
  text: string;
  context: GrepContextLine[];
}

export interface GrepContextResult extends Record<string, unknown> {
  matches: GrepContextMatch[];
  summary: {
    searchedFiles: number;
    matchedFiles: number;
    matches: number;
    skippedFiles: number;
    truncated: boolean;
  };
  result: string;
}

export interface FileOutlineInput {
  path: string;
  maxSymbols?: number;
}

export interface FileOutlineSymbol {
  line: number;
  kind: string;
  name: string;
  text: string;
  exported: boolean;
  indent: number;
}

export interface FileOutlineResult extends Record<string, unknown> {
  path: string;
  symbols: FileOutlineSymbol[];
  summary: {
    symbols: number;
    truncated: boolean;
    lines: number;
  };
  result: string;
}

export async function grepContext(input: GrepContextInput, workspace: Workspace): Promise<GrepContextResult> {
  const query = input.query.trim();
  if (!query) throw new Error("query is required");

  const searchRoot = resolveAllowedPath(input.path ?? ".", workspace.root, [workspace.root]);
  const searchRootStats = await stat(searchRoot);
  const contextLines = clampInteger(input.contextLines, DEFAULT_GREP_CONTEXT_LINES, 0, MAX_GREP_CONTEXT_LINES);
  const maxMatches = clampInteger(input.maxMatches, DEFAULT_GREP_MAX_MATCHES, 1, MAX_GREP_MAX_MATCHES);
  const maxFiles = clampInteger(input.maxFiles, DEFAULT_GREP_MAX_FILES, 1, MAX_GREP_MAX_FILES);
  const maxFileBytes = clampInteger(input.maxFileBytes, DEFAULT_GREP_MAX_FILE_BYTES, 1, MAX_GREP_MAX_FILE_BYTES);
  const includeExtensions = normalizeExtensions(input.includeExtensions);
  const matcher = createLineMatcher(query, Boolean(input.regex), Boolean(input.caseSensitive));

  const files = searchRootStats.isFile()
    ? { paths: [searchRoot], truncated: false }
    : await collectCandidateFiles(searchRoot, workspace.root, maxFiles, includeExtensions);

  const matches: GrepContextMatch[] = [];
  const matchedPaths = new Set<string>();
  let searchedFiles = 0;
  let skippedFiles = 0;
  let truncated = files.truncated;

  for (const filePath of files.paths) {
    if (matches.length >= maxMatches) {
      truncated = true;
      break;
    }

    const text = await readTextFile(filePath, maxFileBytes);
    if (text === undefined) {
      skippedFiles += 1;
      continue;
    }

    searchedFiles += 1;
    const lines = splitLines(text);
    const relativePath = toWorkspaceRelative(workspace.root, filePath);

    for (let index = 0; index < lines.length; index += 1) {
      const column = matcher(lines[index]);
      if (column < 0) continue;

      matchedPaths.add(relativePath);
      matches.push({
        path: relativePath,
        line: index + 1,
        column: column + 1,
        text: lines[index],
        context: contextFor(lines, index, contextLines),
      });

      if (matches.length >= maxMatches) {
        truncated = true;
        break;
      }
    }
  }

  const summary = {
    searchedFiles,
    matchedFiles: matchedPaths.size,
    matches: matches.length,
    skippedFiles,
    truncated,
  };

  return {
    matches,
    summary,
    result: formatGrepContextResult(query, matches, summary),
  };
}

export async function fileOutline(input: FileOutlineInput, workspace: Workspace): Promise<FileOutlineResult> {
  const filePath = resolveAllowedPath(input.path, workspace.root, [workspace.root]);
  const fileStats = await stat(filePath);
  if (!fileStats.isFile()) throw new Error(`Path is not a file: ${input.path}`);

  const maxSymbols = clampInteger(input.maxSymbols, DEFAULT_OUTLINE_MAX_SYMBOLS, 1, MAX_OUTLINE_MAX_SYMBOLS);
  const text = await readTextFile(filePath, DEFAULT_GREP_MAX_FILE_BYTES);
  if (text === undefined) throw new Error(`File is not a supported text file or is too large: ${input.path}`);

  const lines = splitLines(text);
  const symbols: FileOutlineSymbol[] = [];
  let truncated = false;

  for (let index = 0; index < lines.length; index += 1) {
    const symbol = outlineSymbolForLine(lines[index], index + 1);
    if (!symbol) continue;
    symbols.push(symbol);
    if (symbols.length >= maxSymbols) {
      truncated = true;
      break;
    }
  }

  const result: FileOutlineResult = {
    path: toWorkspaceRelative(workspace.root, filePath),
    symbols,
    summary: {
      symbols: symbols.length,
      truncated,
      lines: lines.length,
    },
    result: "",
  };
  result.result = formatFileOutlineResult(result);
  return result;
}

async function collectCandidateFiles(
  root: string,
  workspaceRoot: string,
  maxFiles: number,
  includeExtensions: Set<string> | undefined,
): Promise<{ paths: string[]; truncated: boolean }> {
  const paths: string[] = [];
  let truncated = false;

  async function walk(directory: string): Promise<void> {
    if (paths.length >= maxFiles) {
      truncated = true;
      return;
    }

    let entries: Dirent<string>[];
    try {
      entries = await readDirectory(directory);
    } catch {
      return;
    }

    for (const entry of entries) {
      const child = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (SKIPPED_DIRECTORIES.has(entry.name)) continue;
        await walk(child);
      } else if (entry.isFile() && isSearchableFile(child, includeExtensions)) {
        paths.push(child);
        if (paths.length >= maxFiles) {
          truncated = true;
          return;
        }
      }
    }
  }

  await walk(root);
  paths.sort((a, b) => toWorkspaceRelative(workspaceRoot, a).localeCompare(toWorkspaceRelative(workspaceRoot, b)));
  return { paths, truncated };
}

async function readDirectory(path: string): Promise<Dirent<string>[]> {
  const entries: Dirent<string>[] = [];
  const directory = await opendir(path);
  for await (const entry of directory) entries.push(entry);
  return entries.sort((a, b) => a.name.localeCompare(b.name));
}

async function readTextFile(path: string, maxFileBytes: number): Promise<string | undefined> {
  const fileStats = await stat(path);
  if (!fileStats.isFile() || fileStats.size > maxFileBytes) return undefined;
  if (!isSearchableFile(path, undefined)) return undefined;

  const buffer = await readFile(path);
  if (buffer.includes(0)) return undefined;
  return buffer.toString("utf8");
}

function isSearchableFile(path: string, includeExtensions: Set<string> | undefined): boolean {
  const name = basename(path);
  if (name === "AGENTS.md" || name === "CLAUDE.md" || name === "Dockerfile" || name === "Makefile") return true;
  const extension = extname(path).toLowerCase();
  if (includeExtensions) return includeExtensions.has(extension);
  return DEFAULT_TEXT_EXTENSIONS.has(extension);
}

function normalizeExtensions(extensions: string[] | undefined): Set<string> | undefined {
  if (!extensions || extensions.length === 0) return undefined;
  return new Set(
    extensions
      .map((extension) => extension.trim().toLowerCase())
      .filter(Boolean)
      .map((extension) => (extension.startsWith(".") ? extension : `.${extension}`)),
  );
}

function createLineMatcher(query: string, regex: boolean, caseSensitive: boolean): (line: string) => number {
  if (regex) {
    const expression = new RegExp(query, caseSensitive ? "" : "i");
    return (line) => line.search(expression);
  }

  const needle = caseSensitive ? query : query.toLowerCase();
  return (line) => (caseSensitive ? line : line.toLowerCase()).indexOf(needle);
}

function contextFor(lines: string[], matchIndex: number, radius: number): GrepContextLine[] {
  const start = Math.max(0, matchIndex - radius);
  const end = Math.min(lines.length - 1, matchIndex + radius);
  const context: GrepContextLine[] = [];
  for (let index = start; index <= end; index += 1) {
    context.push({ line: index + 1, text: lines[index], match: index === matchIndex });
  }
  return context;
}

function outlineSymbolForLine(line: string, lineNumber: number): FileOutlineSymbol | undefined {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("//") || (trimmed.startsWith("#") && !/^#{1,6}\s+/.test(trimmed))) return undefined;
  const indent = line.length - line.trimStart().length;

  const patterns: Array<{ kind: string; regex: RegExp }> = [
    { kind: "class", regex: /^(export\s+)?(abstract\s+)?class\s+([A-Za-z_$][\w$]*)/ },
    { kind: "interface", regex: /^(export\s+)?interface\s+([A-Za-z_$][\w$]*)/ },
    { kind: "type", regex: /^(export\s+)?type\s+([A-Za-z_$][\w$]*)/ },
    { kind: "function", regex: /^(export\s+)?(async\s+)?function\s+([A-Za-z_$][\w$]*)/ },
    { kind: "const-function", regex: /^(export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/ },
    { kind: "const", regex: /^(export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\b/ },
    { kind: "python-class", regex: /^class\s+([A-Za-z_][\w]*)/ },
    { kind: "python-function", regex: /^(?:async\s+)?def\s+([A-Za-z_][\w]*)/ },
    { kind: "heading", regex: /^(#{1,6})\s+(.+)/ },
  ];

  for (const pattern of patterns) {
    const match = pattern.regex.exec(trimmed);
    if (!match) continue;
    const exported = Boolean(match[1]?.trim() === "export");
    const name = symbolName(pattern.kind, match);
    if (!name) continue;
    return { line: lineNumber, kind: pattern.kind, name, text: trimmed, exported, indent };
  }

  if (indent <= 4) {
    const methodMatch = /^(?:public\s+|private\s+|protected\s+|static\s+|async\s+)*([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*(?::[^=]+)?\s*[{;]?$/.exec(trimmed);
    if (methodMatch && !["if", "for", "while", "switch", "catch", "function"].includes(methodMatch[1])) {
      return { line: lineNumber, kind: "method", name: methodMatch[1], text: trimmed, exported: false, indent };
    }
  }

  return undefined;
}

function symbolName(kind: string, match: RegExpExecArray): string | undefined {
  if (["class", "function"].includes(kind)) return match[3];
  if (kind === "heading") return match[2]?.trim();
  return match[2] ?? match[1];
}

function formatGrepContextResult(
  query: string,
  matches: GrepContextMatch[],
  summary: GrepContextResult["summary"],
): string {
  const header = `grep_context query=${JSON.stringify(query)} matches=${summary.matches} files=${summary.matchedFiles}/${summary.searchedFiles}${summary.truncated ? " truncated" : ""}`;
  if (matches.length === 0) return `${header}\n(no matches)`;

  return [
    header,
    ...matches.map((match) => [
      `\n# ${match.path}:${match.line}:${match.column}`,
      ...match.context.map((line) => `${line.match ? ">" : " "} ${String(line.line).padStart(5, " ")} | ${line.text}`),
    ].join("\n")),
  ].join("\n");
}

function formatFileOutlineResult(outline: FileOutlineResult): string {
  const header = `file_outline ${outline.path} symbols=${outline.summary.symbols} lines=${outline.summary.lines}${outline.summary.truncated ? " truncated" : ""}`;
  if (outline.symbols.length === 0) return `${header}\n(no symbols found)`;
  return [
    header,
    ...outline.symbols.map((symbol) => {
      const exportFlag = symbol.exported ? " export" : "";
      return `${String(symbol.line).padStart(5, " ")} | ${symbol.kind}${exportFlag} | ${symbol.name}`;
    }),
  ].join("\n");
}

function splitLines(text: string): string[] {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
}

function toWorkspaceRelative(root: string, path: string): string {
  const value = relative(root, resolve(path));
  return value === "" ? "." : value.split(sep).join("/");
}

function clampInteger(value: number | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(value)));
}
