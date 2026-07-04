import { readdir, readFile, stat } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { join, relative, sep } from "node:path";
import { git } from "./git.js";
import type { Workspace } from "./workspaces.js";

const DEFAULT_MAX_FILES = 100;
const MAX_GIT_STATUS_CHARACTERS = 40_000;
const MAX_GIT_STATUS_LINES = 200;
const MAX_PACKAGE_JSON_BYTES = 1_000_000;
const MAX_LIST_DEPTH = 3;
const SKIPPED_DIRECTORIES = new Set([
  ".git",
  ".hg",
  ".svn",
  ".cache",
  ".devspace",
  ".next",
  ".turbo",
  "build",
  "dist",
  "node_modules",
]);

export interface WorkspaceSnapshotInput {
  include?: {
    git?: boolean;
    topLevelFiles?: boolean;
    packageJson?: boolean;
    docs?: boolean;
    src?: boolean;
    agents?: boolean;
  };
  maxFiles?: number;
}

export interface WorkspaceSnapshotResult extends Record<string, unknown> {
  workspaceId: string;
  root: string;
  mode: Workspace["mode"];
  sourceRoot?: string;
  worktree?: Workspace["worktree"];
  git?: {
    isGitRepo: boolean;
    branch: string | null;
    status: string[];
    statusTruncated: boolean;
    error?: string;
  };
  topLevelFiles?: string[];
  readmePresent: boolean;
  packageJsonPresent: boolean;
  agents?: {
    agentsMd: boolean;
    claudeMd: boolean;
  };
  packageJson?: {
    name?: string;
    version?: string;
    type?: string;
    scripts: Record<string, string>;
    dependencies: string[];
    devDependencies: string[];
    error?: string;
  };
  docsFiles?: string[];
  srcFiles?: string[];
  testCommandCandidates: string[];
  summary: {
    files: number;
    truncated: boolean;
  };
  result: string;
}

interface PackageJsonSummary {
  name?: string;
  version?: string;
  type?: string;
  scripts: Record<string, string>;
  dependencies: string[];
  devDependencies: string[];
  error?: string;
}

interface FileBudget {
  remaining: number;
  files: number;
  truncated: boolean;
}

export async function workspaceSnapshot(
  workspace: Workspace,
  input: WorkspaceSnapshotInput = {},
): Promise<WorkspaceSnapshotResult> {
  const include = {
    git: input.include?.git ?? true,
    topLevelFiles: input.include?.topLevelFiles ?? true,
    packageJson: input.include?.packageJson ?? true,
    docs: input.include?.docs ?? true,
    src: input.include?.src ?? true,
    agents: input.include?.agents ?? true,
  };
  const budget: FileBudget = {
    remaining: input.maxFiles ?? DEFAULT_MAX_FILES,
    files: 0,
    truncated: false,
  };
  const rootEntries = await safeReadDirectory(workspace.root);
  const rootNames = new Set(rootEntries.map((entry) => entry.name));
  const readmePresent = rootNames.has("README.md") || rootNames.has("README.MD");
  const packageJsonPresent = rootNames.has("package.json");
  const agents = include.agents
    ? {
        agentsMd: rootNames.has("AGENTS.md") || rootNames.has("AGENTS.MD"),
        claudeMd: rootNames.has("CLAUDE.md") || rootNames.has("CLAUDE.MD"),
      }
    : undefined;
  const topLevelFiles = include.topLevelFiles
    ? collectTopLevelFiles(rootEntries, budget)
    : undefined;
  const docsFiles = include.docs
    ? await collectFiles(workspace.root, "docs", budget)
    : undefined;
  const srcFiles = include.src
    ? await collectFiles(workspace.root, "src", budget)
    : undefined;
  const packageJson =
    include.packageJson && packageJsonPresent
      ? await readPackageJsonSummary(join(workspace.root, "package.json"))
      : undefined;
  const gitSummary = include.git
    ? await collectGitSummary(workspace.root)
    : undefined;
  const testCommandCandidates = inferTestCommands(packageJson?.scripts ?? {});

  const snapshot: WorkspaceSnapshotResult = {
    workspaceId: workspace.id,
    root: workspace.root,
    mode: workspace.mode,
    sourceRoot: workspace.sourceRoot,
    worktree: workspace.worktree,
    git: gitSummary,
    topLevelFiles,
    readmePresent,
    packageJsonPresent,
    agents,
    packageJson,
    docsFiles,
    srcFiles,
    testCommandCandidates,
    summary: {
      files: budget.files,
      truncated: budget.truncated,
    },
    result: "",
  };
  snapshot.result = formatWorkspaceSnapshot(snapshot);
  return snapshot;
}

async function collectGitSummary(
  root: string,
): Promise<NonNullable<WorkspaceSnapshotResult["git"]>> {
  try {
    const inside = (await git(root, ["rev-parse", "--is-inside-work-tree"], {
      maxBuffer: 1_000_000,
    })).stdout.trim();
    if (inside !== "true") {
      return {
        isGitRepo: false,
        branch: null,
        status: [],
        statusTruncated: false,
      };
    }
  } catch {
    return {
      isGitRepo: false,
      branch: null,
      status: [],
      statusTruncated: false,
    };
  }

  let branch: string | null = null;
  let statusLines: string[] = [];
  let statusTruncated = false;
  const errors: string[] = [];

  try {
    branch =
      (await git(root, ["branch", "--show-current"], { maxBuffer: 1_000_000 }))
        .stdout.trim() || null;
  } catch (error) {
    errors.push(`branch: ${errorMessage(error)}`);
  }

  try {
    const status = collectBoundedGitStatus(
      (await git(root, ["status", "--short"], { maxBuffer: 1_000_000 })).stdout,
    );
    statusLines = status.lines;
    statusTruncated = status.truncated;
  } catch (error) {
    errors.push(`status: ${errorMessage(error)}`);
  }

  return {
    isGitRepo: true,
    branch,
    status: statusLines,
    statusTruncated,
    error: errors.length > 0 ? errors.join("; ") : undefined,
  };
}

function collectBoundedGitStatus(output: string): {
  lines: string[];
  truncated: boolean;
} {
  const lines: string[] = [];
  let characters = 0;

  for (const line of output.split(/\r?\n/).filter(Boolean)) {
    if (
      lines.length >= MAX_GIT_STATUS_LINES ||
      characters + line.length > MAX_GIT_STATUS_CHARACTERS
    ) {
      return { lines, truncated: true };
    }
    lines.push(line);
    characters += line.length;
  }

  return { lines, truncated: false };
}

function collectTopLevelFiles(
  entries: Dirent<string>[],
  budget: FileBudget,
): string[] {
  const files: string[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || isSensitiveEnvironmentFile(entry.name)) continue;
    if (!takeFile(budget)) break;
    files.push(entry.name);
  }
  return files.sort();
}

async function collectFiles(
  root: string,
  directoryName: string,
  budget: FileBudget,
): Promise<string[]> {
  const base = join(root, directoryName);
  const files: string[] = [];
  await walkDirectory(root, base, 0, budget, files);
  return files.sort();
}

async function walkDirectory(
  root: string,
  directory: string,
  depth: number,
  budget: FileBudget,
  files: string[],
): Promise<void> {
  if (depth > MAX_LIST_DEPTH || budget.remaining <= 0) {
    if (budget.remaining <= 0) budget.truncated = true;
    return;
  }

  const entries = await safeReadDirectory(directory);
  for (const entry of entries) {
    if (budget.remaining <= 0) {
      budget.truncated = true;
      return;
    }
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRECTORIES.has(entry.name)) {
        await walkDirectory(
          root,
          join(directory, entry.name),
          depth + 1,
          budget,
          files,
        );
      }
      continue;
    }
    if (!entry.isFile() || isSensitiveEnvironmentFile(entry.name)) continue;
    if (!takeFile(budget)) return;
    files.push(toPosixPath(relative(root, join(directory, entry.name))));
  }
}

async function safeReadDirectory(
  directory: string,
): Promise<Dirent<string>[]> {
  try {
    return await readdir(directory, { withFileTypes: true });
  } catch {
    return [];
  }
}

function takeFile(budget: FileBudget): boolean {
  if (budget.remaining <= 0) {
    budget.truncated = true;
    return false;
  }
  budget.remaining -= 1;
  budget.files += 1;
  return true;
}

async function readPackageJsonSummary(
  path: string,
): Promise<PackageJsonSummary> {
  try {
    const fileStats = await stat(path);
    if (fileStats.size > MAX_PACKAGE_JSON_BYTES) {
      throw new Error(
        `package.json exceeds ${MAX_PACKAGE_JSON_BYTES} bytes`,
      );
    }
    const parsed = JSON.parse(await readFile(path, "utf8")) as Record<
      string,
      unknown
    >;
    return {
      name: stringValue(parsed.name),
      version: stringValue(parsed.version),
      type: stringValue(parsed.type),
      scripts: stringRecord(parsed.scripts),
      dependencies: Object.keys(objectRecord(parsed.dependencies)).sort(),
      devDependencies: Object.keys(objectRecord(parsed.devDependencies)).sort(),
    };
  } catch (error) {
    return {
      scripts: {},
      dependencies: [],
      devDependencies: [],
      error: errorMessage(error),
    };
  }
}

function inferTestCommands(scripts: Record<string, string>): string[] {
  return [
    scripts.test ? "npm test" : undefined,
    scripts.typecheck ? "npm run typecheck" : undefined,
    scripts.build ? "npm run build" : undefined,
  ].filter((command): command is string => command !== undefined);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function objectRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringRecord(value: unknown): Record<string, string> {
  return Object.fromEntries(
    Object.entries(objectRecord(value)).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
}

function isSensitiveEnvironmentFile(name: string): boolean {
  return name === ".env" || name.startsWith(".env.");
}

function toPosixPath(path: string): string {
  return path.split(sep).join("/");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatWorkspaceSnapshot(snapshot: WorkspaceSnapshotResult): string {
  const lines = [
    `Workspace: ${snapshot.workspaceId}`,
    `Root: ${snapshot.root}`,
    `Mode: ${snapshot.mode}`,
    snapshot.sourceRoot ? `Source root: ${snapshot.sourceRoot}` : undefined,
    snapshot.git
      ? `Git: ${snapshot.git.isGitRepo ? "yes" : "no"}`
      : undefined,
    snapshot.git?.isGitRepo
      ? `Branch: ${snapshot.git.branch ?? "(detached)"}`
      : undefined,
    snapshot.git?.isGitRepo
      ? `Status: ${
          snapshot.git.status.length > 0
            ? snapshot.git.status.join(" | ")
            : "clean"
        }${snapshot.git.statusTruncated ? " | [truncated]" : ""}`
      : undefined,
    `README.md: ${snapshot.readmePresent ? "yes" : "no"}`,
    `package.json: ${snapshot.packageJsonPresent ? "yes" : "no"}`,
    snapshot.agents
      ? `Instructions: AGENTS.md=${snapshot.agents.agentsMd ? "yes" : "no"}, CLAUDE.md=${snapshot.agents.claudeMd ? "yes" : "no"}`
      : undefined,
    snapshot.packageJson
      ? `Package: ${snapshot.packageJson.name ?? "(unnamed)"}${snapshot.packageJson.version ? `@${snapshot.packageJson.version}` : ""}`
      : undefined,
    snapshot.testCommandCandidates.length > 0
      ? `Test commands: ${snapshot.testCommandCandidates.join(", ")}`
      : "Test commands: none detected",
    snapshot.topLevelFiles
      ? `Top-level files: ${snapshot.topLevelFiles.join(", ") || "(none)"}`
      : undefined,
    snapshot.docsFiles
      ? `Docs files: ${snapshot.docsFiles.join(", ") || "(none)"}`
      : undefined,
    snapshot.srcFiles
      ? `Source files: ${snapshot.srcFiles.join(", ") || "(none)"}`
      : undefined,
    snapshot.summary.truncated
      ? "File lists truncated by maxFiles."
      : undefined,
  ];

  return lines.filter((line): line is string => line !== undefined).join("\n");
}
