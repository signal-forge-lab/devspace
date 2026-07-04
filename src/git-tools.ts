import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { relative, sep } from "node:path";
import { git, getGitEligibility } from "./git.js";
import type { Workspace, WorkspaceRegistry } from "./workspaces.js";

export const MAX_GIT_TOOL_FILES = 100;
export const MAX_GIT_STAGE_HUNK_FILES = 20;
export const MAX_GIT_STAGE_HUNK_EDITS_PER_FILE = 50;
export const MAX_GIT_RECENT_COMMITS = 50;
export const MAX_GIT_DIFF_RANGE_FILES = 100;
export const MAX_GIT_DIFF_RANGE_HUNKS = 500;
export const MAX_GIT_DIFF_RANGE_LINES = 5000;

export interface GitStatusInput {
  includeIgnored?: boolean;
  maxStatusLines?: number;
}

export interface GitStatusResult extends Record<string, unknown> {
  branch: string | null;
  gitRoot: string;
  status: string[];
  statusTruncated: boolean;
  stagedFiles: string[];
  unstagedFiles: string[];
  untrackedFiles: string[];
  result: string;
}

export interface GitRecentCommitsInput {
  maxCount?: number;
}

export interface GitRecentCommitsResult extends Record<string, unknown> {
  commits: string[];
  result: string;
}

export interface GitDiffRangesInput {
  staged?: boolean;
  files?: string[];
  contextLines?: number;
  maxFiles?: number;
  maxHunks?: number;
  maxLines?: number;
}

export interface GitDiffRangesResult extends Record<string, unknown> {
  gitRoot: string;
  staged: boolean;
  files: Array<{
    path: string;
    oldPath?: string;
    status: string;
    additions: number;
    removals: number;
    hunks: Array<{
      header: string;
      oldStart: number;
      oldLines: number;
      newStart: number;
      newLines: number;
      lines: string[];
      truncated: boolean;
    }>;
    truncated: boolean;
  }>;
  summary: {
    fileCount: number;
    hunkCount: number;
    additions: number;
    removals: number;
    truncated: boolean;
    staged: boolean;
  };
  result: string;
}

export interface GitStageFilesInput {
  files: string[];
}

export interface GitStageFilesResult extends Record<string, unknown> {
  stagedFiles: string[];
  result: string;
}

export interface GitCommitFilesInput {
  files: string[];
  message: string;
  allowExistingStaged?: boolean;
  allowEmpty?: boolean;
  dryRun?: boolean;
}

export interface GitCommitStagedInput {
  message: string;
  expectedFiles?: string[];
  allowEmpty?: boolean;
  dryRun?: boolean;
}

export interface GitCommitResult extends Record<string, unknown> {
  committed: boolean;
  commit?: string;
  subject?: string;
  stagedFiles: string[];
  dryRun: boolean;
  result: string;
}

export interface GitStageHunksInput {
  files: Array<{
    path: string;
    edits: Array<{
      oldText: string;
      newText: string;
    }>;
  }>;
  dryRun?: boolean;
}

export interface GitStageHunksResult extends Record<string, unknown> {
  status: "validated" | "staged";
  files: Array<{
    path: string;
    editCount: number;
    additions: number;
    removals: number;
  }>;
  summary: {
    requestedFiles: number;
    editCount: number;
    additions: number;
    removals: number;
    dryRun: boolean;
  };
  result: string;
}

interface GitContext {
  gitRoot: string;
}

interface ResolvedGitPath {
  inputPath: string;
  absolutePath: string;
  gitPath: string;
}

interface PlannedReplacement {
  oldText: string;
  newText: string;
  start: number;
  end: number;
}

async function getGitContext(workspace: Workspace): Promise<GitContext> {
  const eligibility = await getGitEligibility(workspace.root);
  if (!eligibility.ok || !eligibility.gitRoot) {
    throw new Error(eligibility.message ?? "workspace is not inside a usable git repository");
  }
  return { gitRoot: eligibility.gitRoot };
}

function normalizeMaxStatusLines(value: number | undefined): number {
  if (value === undefined) return 200;
  if (!Number.isInteger(value) || value < 1 || value > 1000) {
    throw new Error("maxStatusLines must be an integer between 1 and 1000.");
  }
  return value;
}

function normalizeMaxCommits(value: number | undefined): number {
  if (value === undefined) return 5;
  if (!Number.isInteger(value) || value < 1 || value > MAX_GIT_RECENT_COMMITS) {
    throw new Error(`maxCount must be an integer between 1 and ${MAX_GIT_RECENT_COMMITS}.`);
  }
  return value;
}

function normalizeBoundedInteger(value: number | undefined, defaultValue: number, maxValue: number, label: string): number {
  if (value === undefined) return defaultValue;
  if (!Number.isInteger(value) || value < 0 || value > maxValue) {
    throw new Error(`${label} must be an integer between 0 and ${maxValue}.`);
  }
  return value;
}

function normalizeMessage(message: string): string {
  const normalized = message.trim();
  if (!normalized) throw new Error("commit message must not be empty.");
  if (normalized.length > 500) throw new Error("commit message must be 500 characters or fewer.");
  return normalized;
}

function contentLineCount(content: string): number {
  if (content.length === 0) return 0;
  return content.endsWith("\n")
    ? content.slice(0, -1).split("\n").length
    : content.split("\n").length;
}

function toGitPath(gitRoot: string, absolutePath: string, inputPath: string): string {
  const gitRelative = relative(gitRoot, absolutePath);
  if (!gitRelative || gitRelative.startsWith("..") || gitRelative.includes(`..${sep}`)) {
    throw new Error(`Path is outside git repository root: ${inputPath}`);
  }
  return gitRelative.replace(/\\/g, "/");
}

function resolveGitPaths(
  workspace: Workspace,
  workspaces: WorkspaceRegistry,
  gitRoot: string,
  files: string[],
): ResolvedGitPath[] {
  return files.map((file) => {
    const absolutePath = workspaces.resolvePath(workspace, file);
    return {
      inputPath: file,
      absolutePath,
      gitPath: toGitPath(gitRoot, absolutePath, file),
    };
  });
}

function splitLines(output: string): string[] {
  return output.split(/\r?\n/).filter(Boolean);
}

function boundLines(lines: string[], maxLines: number): { lines: string[]; truncated: boolean } {
  if (lines.length <= maxLines) return { lines, truncated: false };
  return { lines: lines.slice(0, maxLines), truncated: true };
}

async function stagedFileNames(gitRoot: string): Promise<string[]> {
  return splitLines((await git(gitRoot, ["diff", "--cached", "--name-only", "--"])).stdout);
}

async function unstagedFileNames(gitRoot: string): Promise<string[]> {
  return splitLines((await git(gitRoot, ["diff", "--name-only", "--"])).stdout);
}

async function untrackedFileNames(gitRoot: string): Promise<string[]> {
  return splitLines((await git(gitRoot, ["ls-files", "--others", "--exclude-standard"])).stdout);
}

async function formatCurrentCommit(gitRoot: string): Promise<{ commit: string; subject: string }> {
  const commit = (await git(gitRoot, ["rev-parse", "--short", "HEAD"])).stdout.trim();
  const subject = (await git(gitRoot, ["log", "-1", "--pretty=%s"])).stdout.trim();
  return { commit, subject };
}

export async function gitStatusTool(
  input: GitStatusInput,
  workspace: Workspace,
): Promise<GitStatusResult> {
  const { gitRoot } = await getGitContext(workspace);
  const maxStatusLines = normalizeMaxStatusLines(input.maxStatusLines);
  const branch = (await git(gitRoot, ["branch", "--show-current"])).stdout.trim() || null;
  const statusArgs = input.includeIgnored
    ? ["status", "--short", "--ignored"]
    : ["status", "--short"];
  const status = boundLines(splitLines((await git(gitRoot, statusArgs)).stdout), maxStatusLines);
  const stagedFiles = await stagedFileNames(gitRoot);
  const unstagedFiles = await unstagedFileNames(gitRoot);
  const untrackedFiles = await untrackedFileNames(gitRoot);

  const result = [
    `Branch: ${branch ?? "(detached)"}`,
    `Status entries: ${status.lines.length}${status.truncated ? " (truncated)" : ""}`,
    `Staged: ${stagedFiles.length}`,
    `Unstaged: ${unstagedFiles.length}`,
    `Untracked: ${untrackedFiles.length}`,
    status.lines.length > 0 ? "\nStatus:\n" + status.lines.join("\n") : "\nStatus: clean",
  ].join("\n");

  return {
    branch,
    gitRoot,
    status: status.lines,
    statusTruncated: status.truncated,
    stagedFiles,
    unstagedFiles,
    untrackedFiles,
    result,
  };
}

export async function gitRecentCommitsTool(
  input: GitRecentCommitsInput,
  workspace: Workspace,
): Promise<GitRecentCommitsResult> {
  const { gitRoot } = await getGitContext(workspace);
  const maxCount = normalizeMaxCommits(input.maxCount);
  const commits = splitLines(
    (await git(gitRoot, ["log", "--oneline", "--decorate", `--max-count=${maxCount}`])).stdout,
  );
  return {
    commits,
    result: commits.length > 0 ? commits.join("\n") : "No commits found.",
  };
}

export async function gitDiffRangesTool(
  input: GitDiffRangesInput,
  workspace: Workspace,
  workspaces: WorkspaceRegistry,
): Promise<GitDiffRangesResult> {
  const { gitRoot } = await getGitContext(workspace);
  const contextLines = normalizeBoundedInteger(input.contextLines, 3, 20, "contextLines");
  const maxFiles = normalizeBoundedInteger(input.maxFiles, 50, MAX_GIT_DIFF_RANGE_FILES, "maxFiles");
  const maxHunks = normalizeBoundedInteger(input.maxHunks, 200, MAX_GIT_DIFF_RANGE_HUNKS, "maxHunks");
  const maxLines = normalizeBoundedInteger(input.maxLines, 2000, MAX_GIT_DIFF_RANGE_LINES, "maxLines");
  const files = input.files ?? [];
  if (files.length > MAX_GIT_TOOL_FILES) throw new Error(`files must contain ${MAX_GIT_TOOL_FILES} paths or fewer.`);
  const gitPaths = files.length > 0 ? resolveGitPaths(workspace, workspaces, gitRoot, files).map((file) => file.gitPath) : [];
  const args = ["diff", `--unified=${contextLines}`];
  if (input.staged) args.push("--cached");
  args.push("--", ...gitPaths);
  const diff = (await git(gitRoot, args, { maxBuffer: 20 * 1024 * 1024 })).stdout;
  return parseGitDiffRanges(diff, { gitRoot, staged: input.staged ?? false, maxFiles, maxHunks, maxLines });
}

export async function gitStageFilesTool(
  input: GitStageFilesInput,
  workspace: Workspace,
  workspaces: WorkspaceRegistry,
): Promise<GitStageFilesResult> {
  const { gitRoot } = await getGitContext(workspace);
  if (input.files.length === 0 || input.files.length > MAX_GIT_TOOL_FILES) {
    throw new Error(`files must contain 1 to ${MAX_GIT_TOOL_FILES} paths.`);
  }
  const resolved = resolveGitPaths(workspace, workspaces, gitRoot, input.files);
  await git(gitRoot, ["add", "--", ...resolved.map((file) => file.gitPath)]);
  const stagedFiles = await stagedFileNames(gitRoot);

  return {
    stagedFiles,
    result: `Staged ${resolved.length} ${resolved.length === 1 ? "file" : "files"}.`,
  };
}

export async function gitCommitFilesTool(
  input: GitCommitFilesInput,
  workspace: Workspace,
  workspaces: WorkspaceRegistry,
): Promise<GitCommitResult> {
  const { gitRoot } = await getGitContext(workspace);
  if (input.files.length === 0 || input.files.length > MAX_GIT_TOOL_FILES) {
    throw new Error(`files must contain 1 to ${MAX_GIT_TOOL_FILES} paths.`);
  }
  const message = normalizeMessage(input.message);
  const resolved = resolveGitPaths(workspace, workspaces, gitRoot, input.files);
  const requested = new Set(resolved.map((file) => file.gitPath));
  const alreadyStaged = await stagedFileNames(gitRoot);
  const unexpectedStaged = alreadyStaged.filter((file) => !requested.has(file));
  if (!input.allowExistingStaged && unexpectedStaged.length > 0) {
    throw new Error(
      [
        "Refusing to commit because unrelated files are already staged.",
        "Set allowExistingStaged=true to allow this, or commit/unstage them first.",
        ...unexpectedStaged.map((file) => `- ${file}`),
      ].join("\n"),
    );
  }

  if (!input.dryRun) {
    await git(gitRoot, ["add", "--", ...resolved.map((file) => file.gitPath)]);
  }
  const stagedFiles = input.dryRun
    ? Array.from(new Set([...alreadyStaged, ...resolved.map((file) => file.gitPath)])).sort()
    : await stagedFileNames(gitRoot);

  if (!input.allowEmpty && stagedFiles.length === 0) {
    throw new Error("No staged changes to commit.");
  }

  if (input.dryRun) {
    return {
      committed: false,
      stagedFiles,
      dryRun: true,
      result: `Validated commit for ${resolved.length} ${resolved.length === 1 ? "file" : "files"}. No commit was created.`,
    };
  }

  const args = input.allowEmpty ? ["commit", "--allow-empty", "-m", message] : ["commit", "-m", message];
  await git(gitRoot, args);
  const commit = await formatCurrentCommit(gitRoot);
  return {
    committed: true,
    ...commit,
    stagedFiles,
    dryRun: false,
    result: `Committed ${commit.commit} ${commit.subject}`,
  };
}

export async function gitCommitStagedTool(
  input: GitCommitStagedInput,
  workspace: Workspace,
  workspaces: WorkspaceRegistry,
): Promise<GitCommitResult> {
  const { gitRoot } = await getGitContext(workspace);
  const message = normalizeMessage(input.message);
  const stagedFiles = await stagedFileNames(gitRoot);
  if (!input.allowEmpty && stagedFiles.length === 0) {
    throw new Error("No staged changes to commit.");
  }

  if (input.expectedFiles && input.expectedFiles.length > 0) {
    const expected = new Set(
      resolveGitPaths(workspace, workspaces, gitRoot, input.expectedFiles).map((file) => file.gitPath),
    );
    const unexpected = stagedFiles.filter((file) => !expected.has(file));
    const missing = [...expected].filter((file) => !stagedFiles.includes(file));
    if (unexpected.length > 0 || missing.length > 0) {
      throw new Error(
        [
          "Staged files do not match expectedFiles.",
          unexpected.length > 0 ? "Unexpected staged files:" : "",
          ...unexpected.map((file) => `- ${file}`),
          missing.length > 0 ? "Missing expected staged files:" : "",
          ...missing.map((file) => `- ${file}`),
        ].filter(Boolean).join("\n"),
      );
    }
  }

  if (input.dryRun) {
    return {
      committed: false,
      stagedFiles,
      dryRun: true,
      result: `Validated staged commit with ${stagedFiles.length} staged ${stagedFiles.length === 1 ? "file" : "files"}. No commit was created.`,
    };
  }

  const args = input.allowEmpty ? ["commit", "--allow-empty", "-m", message] : ["commit", "-m", message];
  await git(gitRoot, args);
  const commit = await formatCurrentCommit(gitRoot);
  return {
    committed: true,
    ...commit,
    stagedFiles,
    dryRun: false,
    result: `Committed ${commit.commit} ${commit.subject}`,
  };
}

export async function gitStageHunksTool(
  input: GitStageHunksInput,
  workspace: Workspace,
  workspaces: WorkspaceRegistry,
): Promise<GitStageHunksResult> {
  const dryRun = input.dryRun ?? false;
  const { gitRoot } = await getGitContext(workspace);
  if (input.files.length === 0 || input.files.length > MAX_GIT_STAGE_HUNK_FILES) {
    throw new Error(`files must contain 1 to ${MAX_GIT_STAGE_HUNK_FILES} paths.`);
  }

  const planned = [] as Array<{
    path: string;
    gitPath: string;
    mode: string;
    original: string;
    replacements: PlannedReplacement[];
    additions: number;
    removals: number;
  }>;

  for (const file of input.files) {
    if (file.edits.length === 0 || file.edits.length > MAX_GIT_STAGE_HUNK_EDITS_PER_FILE) {
      throw new Error(`files[${file.path}].edits must contain 1 to ${MAX_GIT_STAGE_HUNK_EDITS_PER_FILE} edits.`);
    }
    const [resolved] = resolveGitPaths(workspace, workspaces, gitRoot, [file.path]);
    if (!resolved) throw new Error(`Unable to resolve path: ${file.path}`);
    const indexContent = await readIndexContent(gitRoot, resolved.gitPath);
    const workingContent = await readFile(resolved.absolutePath, "utf8");
    const replacements = planReplacements(file.path, indexContent, file.edits);
    for (const edit of file.edits) {
      if (!workingContent.includes(edit.newText)) {
        throw new Error(`files[${file.path}] newText was not found in the working tree. Refusing to stage a hunk not present on disk.`);
      }
    }
    const stats = summarizeReplacements(replacements);
    const mode = await fileMode(gitRoot, resolved.gitPath);
    planned.push({
      path: file.path,
      gitPath: resolved.gitPath,
      mode,
      original: indexContent,
      replacements,
      ...stats,
    });
  }

  if (!dryRun) {
    for (const plan of planned) {
      const stagedContent = applyReplacements(plan.original, plan.replacements);
      const blob = await hashBlob(gitRoot, stagedContent);
      await git(gitRoot, ["update-index", "--cacheinfo", `${plan.mode},${blob},${plan.gitPath}`]);
    }
  }

  const files = planned.map((plan) => ({
    path: plan.path,
    editCount: plan.replacements.length,
    additions: plan.additions,
    removals: plan.removals,
  }));
  const summary = {
    requestedFiles: files.length,
    editCount: files.reduce((total, file) => total + file.editCount, 0),
    additions: files.reduce((total, file) => total + file.additions, 0),
    removals: files.reduce((total, file) => total + file.removals, 0),
    dryRun,
  };
  const status = dryRun ? "validated" : "staged";

  return {
    status,
    files,
    summary,
    result: formatStageHunksResult(status, files, summary),
  };
}

async function readIndexContent(gitRoot: string, gitPath: string): Promise<string> {
  try {
    return (await git(gitRoot, ["show", `:${gitPath}`], { maxBuffer: 50 * 1024 * 1024 })).stdout;
  } catch {
    throw new Error(`git_stage_hunks currently supports tracked text files only: ${gitPath}`);
  }
}

async function fileMode(gitRoot: string, gitPath: string): Promise<string> {
  const listing = (await git(gitRoot, ["ls-files", "-s", "--", gitPath])).stdout.trim();
  const match = listing.match(/^(\d+)\s+[0-9a-f]+\s+\d+\t/);
  if (!match?.[1]) throw new Error(`Unable to determine git file mode for ${gitPath}.`);
  return match[1];
}

function planReplacements(
  path: string,
  original: string,
  edits: Array<{ oldText: string; newText: string }>,
): PlannedReplacement[] {
  const replacements = edits.map((edit, index) => {
    if (edit.oldText.length === 0) {
      throw new Error(`files[${path}].edits[${index}].oldText must not be empty.`);
    }
    const matches = findAllMatches(original, edit.oldText);
    if (matches.length !== 1) {
      throw new Error(`files[${path}].edits[${index}].oldText matched ${matches.length} times in the index; expected exactly 1.`);
    }
    const start = matches[0] ?? 0;
    return {
      oldText: edit.oldText,
      newText: edit.newText,
      start,
      end: start + edit.oldText.length,
    };
  });

  const sorted = [...replacements].sort((a, b) => a.start - b.start);
  for (let i = 1; i < sorted.length; i += 1) {
    const previous = sorted[i - 1];
    const current = sorted[i];
    if (previous && current && current.start < previous.end) {
      throw new Error(`files[${path}].edits contain overlapping replacements.`);
    }
  }
  return sorted;
}

function findAllMatches(text: string, needle: string): number[] {
  const matches: number[] = [];
  let cursor = 0;
  while (cursor <= text.length) {
    const index = text.indexOf(needle, cursor);
    if (index === -1) break;
    matches.push(index);
    cursor = index + needle.length;
  }
  return matches;
}

function applyReplacements(original: string, replacements: PlannedReplacement[]): string {
  let output = "";
  let cursor = 0;
  for (const replacement of replacements) {
    output += original.slice(cursor, replacement.start);
    output += replacement.newText;
    cursor = replacement.end;
  }
  output += original.slice(cursor);
  return output;
}

function summarizeReplacements(replacements: PlannedReplacement[]): { additions: number; removals: number } {
  return replacements.reduce(
    (summary, replacement) => ({
      additions: summary.additions + contentLineCount(replacement.newText),
      removals: summary.removals + contentLineCount(replacement.oldText),
    }),
    { additions: 0, removals: 0 },
  );
}

function hashBlob(gitRoot: string, content: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", ["hash-object", "-w", "--stdin"], {
      cwd: gitRoot,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(stderr.trim() || `git hash-object failed with code ${code}`));
    });
    child.stdin.end(content);
  });
}

function formatStageHunksResult(
  status: "validated" | "staged",
  files: GitStageHunksResult["files"],
  summary: GitStageHunksResult["summary"],
): string {
  const action = status === "validated" ? "Validated" : "Staged";
  const suffix = status === "validated" ? " No index changes were made." : "";
  const fileLines = files
    .map((file) => `- ${file.path}: ${file.editCount} edits (+${file.additions} -${file.removals})`)
    .join("\n");
  return [
    `${action} ${summary.requestedFiles} ${summary.requestedFiles === 1 ? "file" : "files"} with ${summary.editCount} ${summary.editCount === 1 ? "edit" : "edits"} (+${summary.additions} -${summary.removals}).${suffix}`,
    fileLines,
  ].filter(Boolean).join("\n");
}

interface DiffParseLimits {
  gitRoot: string;
  staged: boolean;
  maxFiles: number;
  maxHunks: number;
  maxLines: number;
}

type DiffFile = GitDiffRangesResult["files"][number];
type DiffHunk = DiffFile["hunks"][number];

function parseGitDiffRanges(diff: string, limits: DiffParseLimits): GitDiffRangesResult {
  const files: DiffFile[] = [];
  let currentFile: DiffFile | undefined;
  let currentHunk: DiffHunk | undefined;
  let hunkCount = 0;
  let emittedLines = 0;
  let truncated = false;

  for (const line of diff.split(/\r?\n/)) {
    if (line.startsWith("diff --git ")) {
      if (files.length >= limits.maxFiles) {
        truncated = true;
        currentFile = undefined;
        currentHunk = undefined;
        continue;
      }
      const paths = parseDiffGitLine(line);
      currentFile = {
        path: paths.newPath ?? paths.oldPath ?? "unknown",
        oldPath: paths.oldPath,
        status: "modified",
        additions: 0,
        removals: 0,
        hunks: [],
        truncated: false,
      };
      files.push(currentFile);
      currentHunk = undefined;
      continue;
    }

    if (!currentFile) continue;
    if (line.startsWith("new file mode ")) currentFile.status = "added";
    else if (line.startsWith("deleted file mode ")) currentFile.status = "deleted";
    else if (line.startsWith("rename from ")) currentFile.status = "renamed";
    else if (line.startsWith("+++ ")) {
      const path = parseDiffPathLine(line, "+++");
      if (path && path !== "/dev/null") currentFile.path = path;
    } else if (line.startsWith("--- ")) {
      const path = parseDiffPathLine(line, "---");
      if (path && path !== "/dev/null") currentFile.oldPath = path;
    }

    if (line.startsWith("@@ ")) {
      if (hunkCount >= limits.maxHunks) {
        truncated = true;
        currentFile.truncated = true;
        currentHunk = undefined;
        continue;
      }
      const hunk = parseHunkHeader(line);
      currentHunk = { ...hunk, header: line, lines: [], truncated: false };
      currentFile.hunks.push(currentHunk);
      hunkCount += 1;
      continue;
    }

    if (!currentHunk) continue;
    if (emittedLines >= limits.maxLines) {
      truncated = true;
      currentFile.truncated = true;
      currentHunk.truncated = true;
      continue;
    }
    currentHunk.lines.push(line);
    emittedLines += 1;
    if (line.startsWith("+") && !line.startsWith("+++")) currentFile.additions += 1;
    if (line.startsWith("-") && !line.startsWith("---")) currentFile.removals += 1;
  }

  const additions = files.reduce((total, file) => total + file.additions, 0);
  const removals = files.reduce((total, file) => total + file.removals, 0);
  const summary = {
    fileCount: files.length,
    hunkCount: files.reduce((total, file) => total + file.hunks.length, 0),
    additions,
    removals,
    truncated,
    staged: limits.staged,
  };

  return {
    gitRoot: limits.gitRoot,
    staged: limits.staged,
    files,
    summary,
    result: formatGitDiffRangesResult(files, summary),
  };
}

function parseDiffGitLine(line: string): { oldPath?: string; newPath?: string } {
  const match = /^diff --git a\/(.*) b\/(.*)$/.exec(line);
  return match ? { oldPath: match[1], newPath: match[2] } : {};
}

function parseDiffPathLine(line: string, marker: "---" | "+++"): string | undefined {
  const value = line.slice(marker.length).trim().split(/\t/)[0] ?? "";
  if (value === "/dev/null") return value;
  return value.replace(/^[ab]\//, "") || undefined;
}

function parseHunkHeader(header: string): Omit<DiffHunk, "header" | "lines" | "truncated"> {
  const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(header);
  if (!match) return { oldStart: 0, oldLines: 0, newStart: 0, newLines: 0 };
  return {
    oldStart: Number(match[1]),
    oldLines: Number(match[2] ?? "1"),
    newStart: Number(match[3]),
    newLines: Number(match[4] ?? "1"),
  };
}

function formatGitDiffRangesResult(files: DiffFile[], summary: GitDiffRangesResult["summary"]): string {
  const lines = [
    `git_diff_ranges ${summary.staged ? "staged" : "unstaged"}: files=${summary.fileCount} hunks=${summary.hunkCount} +${summary.additions} -${summary.removals}${summary.truncated ? " truncated" : ""}`,
  ];
  for (const file of files) {
    lines.push(`\n# ${file.path} (${file.status}) +${file.additions} -${file.removals}${file.truncated ? " truncated" : ""}`);
    for (const hunk of file.hunks) {
      lines.push(`${hunk.header}${hunk.truncated ? " [truncated]" : ""}`);
      lines.push(...hunk.lines);
    }
  }
  if (files.length === 0) lines.push("No diff hunks.");
  return lines.join("\n");
}
