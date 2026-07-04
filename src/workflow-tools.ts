import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { getRuntimeInfo, type RuntimeInfo } from "./app-metadata.js";
import { detectAlternateExecutionPaths, type AlternatePathDetectionResult } from "./alternate-path-detector.js";
import { classifyDevspaceEfficiency, type DevspaceTaskClass } from "./devspace-efficiency-classifier.js";
import { git } from "./git.js";
import { planVerificationPolicy } from "./verification-policy.js";
import type { Workspace } from "./workspaces.js";

export type WorkflowMode = "baseline" | "zip_first" | "router" | "zip_first_router";
export type LocatorType = "line_range" | "anchor" | "between_anchors" | "section_heading" | "regex_single_match" | "exact_text";
export type StructuredEditOperationType = "replace" | "insert_before" | "insert_after" | "replace_section_body";
export type InvariantCheckType = "token_absent" | "token_present" | "regex_count" | "structured_value_equal";

const DEFAULT_MAX_PATCH_BYTES = 200_000;
const DEFAULT_MAX_PATCH_FILES = 10;
const DEFAULT_MAX_PATCH_HUNKS = 50;
const DEFAULT_MAX_STRUCTURED_CONTENT_BYTES = 200_000;
const DEFAULT_MAX_INVARIANT_FILES = 200;
const DEFAULT_MAX_INVARIANT_MATCHES = 50;

export type StructuredContentEncoding = "plain" | "base64";

export interface ExpectedFileHash {
  path: string;
  sha256: string;
}

export interface ApplyUnifiedPatchInput {
  workspace: Workspace;
  patch: string;
  contentEncoding?: StructuredContentEncoding;
  expectedBase: ExpectedFileHash[];
  dryRun?: boolean;
  workflowMode?: WorkflowMode;
  maxPatchBytes?: number;
  maxDecodedBytes?: number;
  maxFiles?: number;
  maxHunks?: number;
  requireTracked?: boolean;
}

export interface PatchFileSummary {
  path: string;
  hunks: number;
  additions: number;
  removals: number;
  oldSha256: string;
  newSha256: string;
}

export interface ApplyUnifiedPatchResult extends Record<string, unknown> {
  status: "validated" | "applied";
  dryRun: boolean;
  workflowMode?: WorkflowMode;
  contentEncoding: StructuredContentEncoding;
  decodedBytes: number;
  files: PatchFileSummary[];
  summary: {
    fileCount: number;
    hunkCount: number;
    additions: number;
    removals: number;
  };
  result: string;
}

export interface LocatorInput {
  type: LocatorType;
  startLine?: number;
  endLine?: number;
  anchor?: string;
  startAnchor?: string;
  endAnchor?: string;
  heading?: string;
  pattern?: string;
  flags?: string;
  exactText?: string;
  occurrence?: number;
  includeStartAnchor?: boolean;
  includeEndAnchor?: boolean;
  includeHeading?: boolean;
}

export interface LocatorCandidate {
  candidateId: string;
  lineStart: number;
  lineEnd: number;
  startOffset: number;
  endOffset: number;
  selectedHash: string;
  preview: string;
}

export interface ResolveLocatorInput {
  workspace: Workspace;
  path: string;
  locator: LocatorInput;
  expectedSha256?: string;
  maxPreviewChars?: number;
}

export interface ResolveLocatorResult extends Record<string, unknown> {
  path: string;
  sha256: string;
  lineCount: number;
  matchCount: number;
  selected?: LocatorCandidate;
  candidates: LocatorCandidate[];
  result: string;
}

export interface ApplyStructuredEditInput extends ResolveLocatorInput {
  operation: {
    type: StructuredEditOperationType;
    content: string;
    contentEncoding?: StructuredContentEncoding;
    maxDecodedBytes?: number;
  };
  dryRun?: boolean;
  workflowMode?: WorkflowMode;
}

export interface ApplyStructuredEditResult extends Record<string, unknown> {
  status: "validated" | "applied";
  path: string;
  dryRun: boolean;
  workflowMode?: WorkflowMode;
  contentEncoding: StructuredContentEncoding;
  decodedBytes: number;
  lineStart: number;
  lineEnd: number;
  selectedHash: string;
  oldSha256: string;
  newSha256: string;
  additions: number;
  removals: number;
  result: string;
}

export interface InvariantCheckInput {
  workspace: Workspace;
  checks: InvariantCheck[];
  workflowMode?: WorkflowMode;
  maxFiles?: number;
  maxMatches?: number;
}

export type InvariantCheck =
  | { type: "token_absent"; token: string; paths: string[]; id?: string }
  | { type: "token_present"; token: string; paths: string[]; minCount?: number; id?: string }
  | { type: "regex_count"; pattern: string; flags?: string; paths: string[]; minCount?: number; maxCount?: number; id?: string }
  | { type: "structured_value_equal"; values: Array<{ path: string; pointer: string }>; id?: string };

export interface InvariantCheckResultItem extends Record<string, unknown> {
  id: string;
  type: InvariantCheckType;
  ok: boolean;
  count?: number;
  expected?: unknown;
  actual?: unknown;
  matches?: Array<{ path: string; line: number; text: string }>;
  message: string;
}

export interface InvariantCheckResult extends Record<string, unknown> {
  status: "ok" | "failed";
  workflowMode?: WorkflowMode;
  checks: InvariantCheckResultItem[];
  summary: { total: number; failed: number };
  result: string;
}

export interface WorkflowEventInput {
  workspace: Workspace;
  workflowMode: WorkflowMode;
  event: string;
  action?: string;
  tool?: string;
  status?: string;
  filesRead?: number;
  filesChanged?: number;
  testsRun?: number;
  hostBlocks?: number;
  outputChars?: number;
  durationMs?: number;
  note?: string;
}

export interface WorkflowEventResult extends Record<string, unknown> {
  recorded: boolean;
  eventId: string;
  path: string;
  workflowMode: WorkflowMode;
  result: string;
}

export type RouterAction = "start" | "snapshot" | "inspect" | "resolve_locator" | "check_invariants" | "summarize" | "verify_plan" | "suggest_verify";
export type RouterMode = "plan_only" | "read_only";

export interface DevspaceRouterInput {
  workspace: Workspace;
  workflowMode: WorkflowMode;
  action: RouterAction;
  mode?: RouterMode;
  intent?: string;
  taskClass?: DevspaceTaskClass;
  refs?: Record<string, string | undefined>;
  targets?: {
    paths?: string[];
    numbers?: number[];
  };
  locatorRequest?: {
    path: string;
    locator: LocatorInput;
    expectedSha256?: string;
  };
  invariantChecks?: InvariantCheck[];
  limits?: {
    maxFiles?: number;
    maxLines?: number;
    maxOutputChars?: number;
    maxPreviewChars?: number;
  };
}

export interface DevspaceRouterResult extends Record<string, unknown> {
  status: "ok" | "blocked";
  action: RouterAction;
  mode: RouterMode;
  workflowMode: WorkflowMode;
  refs: Record<string, string>;
  summary: Record<string, unknown>;
  results: Record<string, unknown>;
  nextRecommendedAction?: string;
  warnings: string[];
  runtimeInfo: RuntimeInfo;
  result: string;
}

interface ParsedPatchFile {
  path: string;
  hunks: ParsedHunk[];
}

interface ParsedHunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  lines: string[];
}

interface LineInfo {
  lines: string[];
  newline: string;
  hasFinalNewline: boolean;
}

function upstreamToolRouteGuidance(): Record<string, unknown> {
  return {
    modePolicy: "Workbridge codex mode is Codex-compatible plus Workbridge guide/diagnostics/bounded workflow helpers.",
    patchTools: [
      { tool: "apply_patch", useWhen: "Codex patch format, add/update/delete/move operations, or a patch already wrapped in Begin/End Patch markers." },
      { tool: "apply_unified_patch", useWhen: "Hash-guarded unified diffs with expectedBase sha256 checks." },
      { tool: "apply_structured_edit", useWhen: "Locator-based structured edits after resolve_locator and dry-run planning." },
    ],
    processTools: [
      { tool: "devspace_verify", useWhen: "Fixed verification profiles such as git status/diff, typecheck, tests, and build." },
      { tool: "bash", useWhen: "Bounded minimal/full-mode tests, builds, or inspection when no fixed profile fits." },
      { tool: "exec_command/write_stdin", useWhen: "Codex-mode long-running, interactive, PTY, polling, stdin, or Ctrl-C workflows." },
    ],
  };
}

export async function devspaceRouter(input: DevspaceRouterInput): Promise<DevspaceRouterResult> {
  const mode: RouterMode = input.mode ?? "read_only";
  const warnings: string[] = [];
  if (input.intent && input.intent.length > 500) warnings.push("intent_is_long_keep_router_requests_small");
  const refs = compactRefs({
    jobId: input.refs?.jobId ?? `job_${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}_${randomBytes(3).toString("hex")}`,
    ...input.refs,
  });
  const limits = normalizeRouterLimits(input.limits);

  if (input.action === "start") {
    return routerResult({
      input,
      mode,
      refs,
      warnings,
      summary: {
        intent: input.intent ?? "",
        rule: "Use action + targets + refs + limits. Do not pass large content, shell commands, or patches.",
        workflowMode: input.workflowMode,
      },
      results: {
        allowedActions: ["snapshot", "inspect", "resolve_locator", "check_invariants", "summarize", "verify_plan", "suggest_verify"],
        editTools: ["apply_patch", "apply_unified_patch", "apply_structured_edit", "edit_by_line_range"],
        routeGuidance: upstreamToolRouteGuidance(),
      },
      nextRecommendedAction: "snapshot",
    });
  }

  if (input.action === "snapshot") {
    const status = await git(input.workspace.root, ["status", "--short"], { maxBuffer: 512 * 1024 });
    const tracked = await trackedFiles(input.workspace.root);
    const trackedList = [...tracked].slice(0, limits.maxFiles);
    return routerResult({
      input,
      mode,
      refs,
      warnings,
      summary: { trackedFiles: tracked.size, shownFiles: trackedList.length, dirtyLines: status.stdout.split(/\r?\n/).filter(Boolean).length },
      results: { gitStatus: status.stdout.split(/\r?\n/).filter(Boolean).slice(0, 100), trackedFiles: trackedList },
      nextRecommendedAction: "inspect",
    });
  }

  if (input.action === "inspect") {
    const files = await expandInputPaths(input.workspace, input.targets?.paths ?? [], limits.maxFiles);
    const inspected = [];
    for (const path of files.slice(0, limits.maxFiles)) {
      const content = await readFile(resolveWorkspaceFile(input.workspace, path), "utf8");
      const lineInfo = splitLines(content);
      inspected.push({
        path,
        sha256: sha256(content),
        lineCount: lineInfo.lines.length,
        preview: lineInfo.lines.slice(0, limits.maxLines).join("\n").slice(0, limits.maxOutputChars),
      });
    }
    return routerResult({
      input,
      mode,
      refs,
      warnings,
      summary: { fileCount: inspected.length, maxLines: limits.maxLines, maxOutputChars: limits.maxOutputChars },
      results: { files: inspected },
      nextRecommendedAction: "resolve_locator_or_prepare_patch",
    });
  }

  if (input.action === "resolve_locator") {
    if (!input.locatorRequest) return blockedRouterResult(input, mode, refs, warnings, "locatorRequest is required for resolve_locator.");
    const located = await resolveLocator({
      workspace: input.workspace,
      path: input.locatorRequest.path,
      locator: input.locatorRequest.locator,
      expectedSha256: input.locatorRequest.expectedSha256,
      maxPreviewChars: limits.maxPreviewChars,
    });
    return routerResult({
      input,
      mode,
      refs,
      warnings,
      summary: { path: located.path, matchCount: located.matchCount, selected: Boolean(located.selected) },
      results: { locator: located },
      nextRecommendedAction: located.selected ? "apply_structured_edit_dry_run" : "retry_with_more_specific_locator",
    });
  }


  if (input.action === "verify_plan" || input.action === "suggest_verify") {
    const status = await git(input.workspace.root, ["status", "--short"], { maxBuffer: 512 * 1024 });
    const dirtyPaths = parseGitStatusPaths(status.stdout);
    const targetPaths = (input.targets?.paths ?? []).map(normalizeWorkspaceRelativePath);
    const plan = buildVerifyPlan([...new Set([...targetPaths, ...dirtyPaths])], input.intent ?? "", input.taskClass);
    return routerResult({
      input,
      mode,
      refs,
      warnings,
      summary: {
        profileCount: plan.profiles.length,
        pathCount: plan.paths.length,
        dirtyPathCount: dirtyPaths.length,
        taskClass: plan.taskClass,
        alternatePathCount: plan.alternatePaths.length,
      },
      results: { verifyPlan: plan, routeGuidance: upstreamToolRouteGuidance(), gitStatus: status.stdout.split(/\r?\n/).filter(Boolean).slice(0, 100) },
      nextRecommendedAction: plan.profiles.length > 0 ? `devspace_verify:${plan.profiles[0]}` : "git_status_check",
    });
  }

  if (input.action === "check_invariants") {
    if (!input.invariantChecks || input.invariantChecks.length === 0) return blockedRouterResult(input, mode, refs, warnings, "invariantChecks are required for check_invariants.");
    const checked = await checkWorkspaceInvariants({
      workspace: input.workspace,
      workflowMode: input.workflowMode,
      checks: input.invariantChecks,
      maxFiles: limits.maxFiles,
      maxMatches: 50,
    });
    return routerResult({
      input,
      mode,
      refs,
      warnings,
      summary: checked.summary,
      results: { invariants: checked },
      nextRecommendedAction: checked.status === "ok" ? "verify_or_summarize" : "fix_failed_invariants",
    });
  }

  const status = await git(input.workspace.root, ["status", "--short"], { maxBuffer: 512 * 1024 });
  return routerResult({
    input,
    mode,
    refs,
    warnings,
    summary: { dirtyLines: status.stdout.split(/\r?\n/).filter(Boolean).length },
    results: { gitStatus: status.stdout.split(/\r?\n/).filter(Boolean).slice(0, 100) },
    nextRecommendedAction: "choose_next_workflow_step",
  });
}


function parseGitStatusPaths(stdout: string): string[] {
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.slice(2).trim())
    .map((path) => path.includes(" -> ") ? path.split(" -> ").at(-1) ?? path : path)
    .map(normalizeWorkspaceRelativePath)
    .filter(Boolean);
}

function buildVerifyPlan(paths: string[], intent: string, requestedTaskClass?: DevspaceTaskClass): { profiles: string[]; paths: string[]; reasons: string[]; commandSequence: Array<{ tool: string; profile: string }>; taskClass: DevspaceTaskClass; alternatePaths: AlternatePathDetectionResult[]; note: string } {
  const normalizedPaths = Array.from(new Set(paths.map(normalizeWorkspaceRelativePath).filter(Boolean))).sort();
  const classification = classifyDevspaceEfficiency({ intent: `${intent} ${normalizedPaths.join(" ")}`, fileCount: normalizedPaths.length, writesFiles: normalizedPaths.length > 0, taskClass: requestedTaskClass });
  const policy = planVerificationPolicy({ taskClass: classification.taskClass, paths: normalizedPaths, intent });
  const alternatePaths = classification.taskClass === "large_edit_refactor"
    ? detectAlternateExecutionPaths(normalizedPaths.map((path) => ({ path }))).slice(0, 20)
    : [];

  return {
    profiles: policy.profiles,
    paths: normalizedPaths,
    reasons: policy.reasons,
    commandSequence: policy.profiles.map((profile) => ({ tool: "devspace_verify", profile })),
    taskClass: classification.taskClass,
    alternatePaths,
    note: `${policy.note}${alternatePaths.length ? " Large refactor plan includes alternate execution path candidates." : ""}`,
  };
}

export async function applyUnifiedPatch(input: ApplyUnifiedPatchInput): Promise<ApplyUnifiedPatchResult> {
  validateLimit("maxPatchBytes", input.maxPatchBytes, DEFAULT_MAX_PATCH_BYTES, 1, 1_000_000);
  validateLimit("maxDecodedBytes", input.maxDecodedBytes, DEFAULT_MAX_STRUCTURED_CONTENT_BYTES, 1, 1_000_000);
  validateLimit("maxFiles", input.maxFiles, DEFAULT_MAX_PATCH_FILES, 1, 100);
  validateLimit("maxHunks", input.maxHunks, DEFAULT_MAX_PATCH_HUNKS, 1, 500);
  const maxPatchBytes = input.maxPatchBytes ?? DEFAULT_MAX_PATCH_BYTES;
  const decoded = decodeStructuredContent({ content: input.patch, contentEncoding: input.contentEncoding, maxDecodedBytes: input.maxDecodedBytes ?? maxPatchBytes, label: "patch" });
  const patch = decoded.content;
  const maxFiles = input.maxFiles ?? DEFAULT_MAX_PATCH_FILES;
  const maxHunks = input.maxHunks ?? DEFAULT_MAX_PATCH_HUNKS;
  if (decoded.decodedBytes > maxPatchBytes) throw new Error(`patch exceeds maxPatchBytes: ${decoded.decodedBytes} > ${maxPatchBytes}.`);
  const parsed = parseUnifiedPatch(patch);
  if (parsed.length === 0) throw new Error("patch contains no supported file hunks.");
  if (parsed.length > maxFiles) throw new Error(`patch file count exceeds maxFiles: ${parsed.length} > ${maxFiles}.`);
  const hunkCount = parsed.reduce((sum, file) => sum + file.hunks.length, 0);
  if (hunkCount > maxHunks) throw new Error(`patch hunk count exceeds maxHunks: ${hunkCount} > ${maxHunks}.`);

  const expected = new Map(input.expectedBase.map((entry) => [normalizeWorkspaceRelativePath(entry.path), entry.sha256]));
  for (const file of parsed) {
    if (!expected.has(file.path)) throw new Error(`expectedBase is required for patch target: ${file.path}.`);
  }

  if (input.requireTracked ?? true) {
    const tracked = await trackedFiles(input.workspace.root);
    for (const file of parsed) {
      if (!tracked.has(file.path)) throw new Error(`patch target is not git-tracked: ${file.path}.`);
    }
  }

  const summaries: PatchFileSummary[] = [];
  for (const file of parsed) {
    const absolutePath = resolveWorkspaceFile(input.workspace, file.path);
    const original = await readFile(absolutePath, "utf8");
    const oldSha256 = sha256(original);
    const expectedSha = expected.get(file.path);
    if (expectedSha && expectedSha !== oldSha256) {
      throw new Error(`sha256 mismatch for ${file.path}: expected ${expectedSha}, actual ${oldSha256}.`);
    }
    const { output, additions, removals } = applyParsedFilePatch(original, file);
    const newSha256 = sha256(output);
    if (!input.dryRun) await writeFile(absolutePath, output, "utf8");
    summaries.push({ path: file.path, hunks: file.hunks.length, additions, removals, oldSha256, newSha256 });
  }

  const summary = {
    fileCount: summaries.length,
    hunkCount,
    additions: summaries.reduce((sum, file) => sum + file.additions, 0),
    removals: summaries.reduce((sum, file) => sum + file.removals, 0),
  };
  const status = input.dryRun ? "validated" : "applied";
  const result = `${status} unified patch: files=${summary.fileCount} hunks=${summary.hunkCount} +${summary.additions} -${summary.removals}`;
  return { status, dryRun: input.dryRun ?? false, workflowMode: input.workflowMode, contentEncoding: decoded.contentEncoding, decodedBytes: decoded.decodedBytes, files: summaries, summary, result };
}

export async function resolveLocator(input: ResolveLocatorInput): Promise<ResolveLocatorResult> {
  const absolutePath = resolveWorkspaceFile(input.workspace, input.path);
  const content = await readFile(absolutePath, "utf8");
  const currentSha256 = sha256(content);
  if (input.expectedSha256 && input.expectedSha256 !== currentSha256) {
    throw new Error(`sha256 mismatch for ${input.path}: expected ${input.expectedSha256}, actual ${currentSha256}.`);
  }
  const lineInfo = splitLines(content);
  const ranges = locatorRanges(content, lineInfo, input.locator);
  const candidates = ranges.map((range, index) => candidateForRange(content, lineInfo, range.start, range.end, index + 1, input.maxPreviewChars ?? 240));
  const occurrence = input.locator.occurrence;
  const selected = occurrence !== undefined ? candidates[occurrence - 1] : candidates.length === 1 ? candidates[0] : undefined;
  const result = selected
    ? `resolved ${input.locator.type} in ${input.path}: ${selected.lineStart}-${selected.lineEnd} hash=${selected.selectedHash}`
    : `resolved ${input.locator.type} in ${input.path}: matches=${candidates.length}`;
  return { path: input.path, sha256: currentSha256, lineCount: lineInfo.lines.length, matchCount: candidates.length, selected, candidates: candidates.slice(0, 20), result };
}

export async function applyStructuredEdit(input: ApplyStructuredEditInput): Promise<ApplyStructuredEditResult> {
  const absolutePath = resolveWorkspaceFile(input.workspace, input.path);
  const original = await readFile(absolutePath, "utf8");
  const oldSha256 = sha256(original);
  if (input.expectedSha256 && input.expectedSha256 !== oldSha256) {
    throw new Error(`sha256 mismatch for ${input.path}: expected ${input.expectedSha256}, actual ${oldSha256}.`);
  }
  const lineInfo = splitLines(original);
  const ranges = locatorRanges(original, lineInfo, input.locator);
  const occurrence = input.locator.occurrence;
  if (ranges.length === 0) throw new Error(`locator ${input.locator.type} matched 0 ranges.`);
  if (occurrence !== undefined && (!Number.isInteger(occurrence) || occurrence < 1 || occurrence > ranges.length)) throw new Error(`occurrence ${occurrence} is invalid for ${ranges.length} matches.`);
  if (occurrence === undefined && ranges.length !== 1) throw new Error(`locator ${input.locator.type} matched ${ranges.length} ranges; expected exactly 1 or provide occurrence.`);
  const range = occurrence === undefined ? ranges[0] : ranges[occurrence - 1];
  const selected = original.slice(range.start, range.end);
  const selectedHash = sha256(selected);
  const decoded = decodeStructuredContent({ content: input.operation.content, contentEncoding: input.operation.contentEncoding, maxDecodedBytes: input.operation.maxDecodedBytes, label: "structured edit content" });
  const operation = { ...input.operation, content: decoded.content };
  const output = structuredEditOutput(original, range.start, range.end, operation);
  if (!input.dryRun) await writeFile(absolutePath, output, "utf8");
  const newSha256 = sha256(output);
  const candidate = candidateForRange(original, lineInfo, range.start, range.end, occurrence ?? 1, 120);
  const status = input.dryRun ? "validated" : "applied";
  const additions = contentLineCount(decoded.content);
  const removals = input.operation.type.startsWith("insert_") ? 0 : contentLineCount(selected);
  return {
    status,
    path: input.path,
    dryRun: input.dryRun ?? false,
    workflowMode: input.workflowMode,
    contentEncoding: decoded.contentEncoding,
    decodedBytes: decoded.decodedBytes,
    lineStart: candidate.lineStart,
    lineEnd: candidate.lineEnd,
    selectedHash,
    oldSha256,
    newSha256,
    additions,
    removals,
    result: `${status} structured edit ${input.operation.type} on ${input.path}:${candidate.lineStart}-${candidate.lineEnd} +${additions} -${removals}`,
  };
}

export async function checkWorkspaceInvariants(input: InvariantCheckInput): Promise<InvariantCheckResult> {
  const maxFiles = input.maxFiles ?? DEFAULT_MAX_INVARIANT_FILES;
  const maxMatches = input.maxMatches ?? DEFAULT_MAX_INVARIANT_MATCHES;
  validateLimit("maxFiles", maxFiles, DEFAULT_MAX_INVARIANT_FILES, 1, 1000);
  validateLimit("maxMatches", maxMatches, DEFAULT_MAX_INVARIANT_MATCHES, 1, 1000);
  const items: InvariantCheckResultItem[] = [];
  for (const [index, check] of input.checks.entries()) {
    const id = check.id ?? `${check.type}_${index + 1}`;
    if (check.type === "structured_value_equal") {
      const values = await Promise.all(check.values.map(async (entry) => readStructuredValue(input.workspace, entry.path, entry.pointer)));
      const first = values[0];
      const ok = values.every((value) => stableJson(value) === stableJson(first));
      items.push({ id, type: check.type, ok, expected: first, actual: values, message: ok ? `structured values match for ${check.values.length} files` : "structured values differ" });
      continue;
    }
    const files = await expandInputPaths(input.workspace, check.paths, maxFiles);
    const matches = await findInvariantMatches(input.workspace, files, check, maxMatches);
    if (check.type === "token_absent") {
      const ok = matches.length === 0;
      items.push({ id, type: check.type, ok, count: matches.length, matches, message: ok ? `token absent: ${check.token}` : `token still present: ${check.token}` });
    } else if (check.type === "token_present") {
      const minCount = check.minCount ?? 1;
      const ok = matches.length >= minCount;
      items.push({ id, type: check.type, ok, count: matches.length, matches, message: ok ? `token present ${matches.length} times: ${check.token}` : `token count ${matches.length} < ${minCount}: ${check.token}` });
    } else {
      const minCount = check.minCount ?? 0;
      const maxCount = check.maxCount ?? Number.MAX_SAFE_INTEGER;
      const ok = matches.length >= minCount && matches.length <= maxCount;
      items.push({ id, type: check.type, ok, count: matches.length, matches, message: ok ? `regex count ok: ${matches.length}` : `regex count ${matches.length} outside ${minCount}-${maxCount}` });
    }
  }
  const failed = items.filter((item) => !item.ok).length;
  const status = failed === 0 ? "ok" : "failed";
  const result = `${status}: invariant checks total=${items.length} failed=${failed}`;
  return { status, workflowMode: input.workflowMode, checks: items, summary: { total: items.length, failed }, result };
}

export async function recordWorkflowEvent(input: WorkflowEventInput): Promise<WorkflowEventResult> {
  const eventId = `wfe_${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}_${randomBytes(4).toString("hex")}`;
  const dir = join(input.workspace.root, ".devspace", "workflow-events");
  await mkdir(dir, { recursive: true });
  const path = join(dir, "events.jsonl");
  const record = {
    eventId,
    createdAt: new Date().toISOString(),
    workspaceId: input.workspace.id,
    workspaceRoot: input.workspace.root,
    workflowMode: input.workflowMode,
    event: input.event,
    action: input.action,
    tool: input.tool,
    status: input.status,
    filesRead: input.filesRead,
    filesChanged: input.filesChanged,
    testsRun: input.testsRun,
    hostBlocks: input.hostBlocks,
    outputChars: input.outputChars,
    durationMs: input.durationMs,
    note: input.note,
  };
  await writeFile(path, `${JSON.stringify(record)}\n`, { encoding: "utf8", flag: "a" });
  return { recorded: true, eventId, path, workflowMode: input.workflowMode, result: `Recorded workflow event ${eventId} (${input.workflowMode}:${input.event}).` };
}

function parseUnifiedPatch(patch: string): ParsedPatchFile[] {
  const lines = patch.replace(/\r\n/g, "\n").split("\n");
  const files: ParsedPatchFile[] = [];
  let current: ParsedPatchFile | undefined;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith("Binary files ") || line.startsWith("GIT binary patch")) throw new Error("binary patches are not supported.");
    if (line.startsWith("diff --git ")) { current = undefined; continue; }
    if (line.startsWith("--- ")) {
      const next = lines[i + 1] ?? "";
      if (!next.startsWith("+++ ")) throw new Error("invalid unified patch: --- without +++.");
      const oldPath = patchHeaderPath(line.slice(4));
      const newPath = patchHeaderPath(next.slice(4));
      if (oldPath === "/dev/null" || newPath === "/dev/null") throw new Error("file create/delete patches are not supported.");
      if (oldPath !== newPath) throw new Error(`rename or path-changing patch is not supported: ${oldPath} -> ${newPath}.`);
      current = { path: normalizeWorkspaceRelativePath(newPath), hunks: [] };
      files.push(current);
      i += 1;
      continue;
    }
    if (line.startsWith("@@ ")) {
      if (!current) throw new Error("hunk encountered before file header.");
      const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (!match) throw new Error(`invalid hunk header: ${line}`);
      const hunk: ParsedHunk = { oldStart: Number(match[1]), oldCount: match[2] ? Number(match[2]) : 1, newStart: Number(match[3]), newCount: match[4] ? Number(match[4]) : 1, lines: [] };
      i += 1;
      for (; i < lines.length; i++) {
        const hunkLine = lines[i];
        if (hunkLine.startsWith("@@ ") || hunkLine.startsWith("diff --git ") || hunkLine.startsWith("--- ")) { i -= 1; break; }
        if (hunkLine === "\ No newline at end of file") continue;
        if (!/^[ +\-]/.test(hunkLine) && hunkLine !== "") throw new Error(`invalid hunk line: ${hunkLine}`);
        hunk.lines.push(hunkLine);
      }
      validateHunkCounts(hunk);
      current.hunks.push(hunk);
    }
  }
  return files.filter((file) => file.hunks.length > 0);
}

function patchHeaderPath(raw: string): string {
  const trimmed = raw.trim().split(/\t| /)[0];
  if (trimmed === "/dev/null") return trimmed;
  return trimmed.replace(/^[ab]\//, "");
}

function validateHunkCounts(hunk: ParsedHunk): void {
  const oldCount = hunk.lines.filter((line) => line.startsWith(" ") || line.startsWith("-")).length;
  const newCount = hunk.lines.filter((line) => line.startsWith(" ") || line.startsWith("+")).length;
  if (oldCount !== hunk.oldCount) throw new Error(`hunk old count mismatch at -${hunk.oldStart}: header=${hunk.oldCount} actual=${oldCount}.`);
  if (newCount !== hunk.newCount) throw new Error(`hunk new count mismatch at +${hunk.newStart}: header=${hunk.newCount} actual=${newCount}.`);
}

function applyParsedFilePatch(original: string, file: ParsedPatchFile): { output: string; additions: number; removals: number } {
  const info = splitLines(original);
  const out = [...info.lines];
  let offset = 0;
  let additions = 0;
  let removals = 0;
  for (const hunk of file.hunks) {
    const startIndex = hunk.oldStart - 1 + offset;
    if (startIndex < 0 || startIndex > out.length) throw new Error(`hunk start out of range for ${file.path}: ${hunk.oldStart}.`);
    const expected: string[] = [];
    const replacement: string[] = [];
    for (const line of hunk.lines) {
      const marker = line[0];
      const text = line.slice(1);
      if (marker === " ") { expected.push(text); replacement.push(text); }
      else if (marker === "-") { expected.push(text); removals += 1; }
      else if (marker === "+") { replacement.push(text); additions += 1; }
    }
    const actual = out.slice(startIndex, startIndex + expected.length);
    if (actual.join("\n") !== expected.join("\n")) throw new Error(`patch context mismatch for ${file.path} at line ${hunk.oldStart}.`);
    out.splice(startIndex, expected.length, ...replacement);
    offset += replacement.length - expected.length;
  }
  return { output: joinLines(out, info), additions, removals };
}

function locatorRanges(content: string, lineInfo: LineInfo, locator: LocatorInput): Array<{ start: number; end: number }> {
  switch (locator.type) {
    case "line_range": {
      if (!locator.startLine || !locator.endLine || locator.startLine < 1 || locator.endLine < locator.startLine || locator.endLine > lineInfo.lines.length) throw new Error("invalid line_range locator.");
      return [{ start: offsetForLine(lineInfo.lines, locator.startLine), end: endOffsetForLine(lineInfo.lines, locator.endLine) }];
    }
    case "anchor": {
      if (!locator.anchor) throw new Error("anchor locator requires anchor.");
      return findAllOffsets(content, locator.anchor).map((start) => ({ start, end: start + locator.anchor!.length }));
    }
    case "between_anchors": {
      if (!locator.startAnchor || !locator.endAnchor) throw new Error("between_anchors requires startAnchor and endAnchor.");
      const ranges: Array<{ start: number; end: number }> = [];
      for (const startAnchorOffset of findAllOffsets(content, locator.startAnchor)) {
        const afterStart = startAnchorOffset + locator.startAnchor.length;
        const endAnchorOffset = content.indexOf(locator.endAnchor, afterStart);
        if (endAnchorOffset >= 0) ranges.push({ start: locator.includeStartAnchor ? startAnchorOffset : afterStart, end: locator.includeEndAnchor ? endAnchorOffset + locator.endAnchor.length : endAnchorOffset });
      }
      return ranges;
    }
    case "section_heading": {
      if (!locator.heading) throw new Error("section_heading requires heading.");
      const heading = locator.heading.trim();
      const headingLevel = markdownHeadingLevel(heading);
      if (!headingLevel) throw new Error("heading must start with one or more # characters.");
      const ranges: Array<{ start: number; end: number }> = [];
      for (let i = 0; i < lineInfo.lines.length; i++) {
        if (lineInfo.lines[i].trim() !== heading) continue;
        let endLine = lineInfo.lines.length;
        for (let j = i + 1; j < lineInfo.lines.length; j++) {
          const level = markdownHeadingLevel(lineInfo.lines[j].trim());
          if (level && level <= headingLevel) { endLine = j; break; }
        }
        const startLine = locator.includeHeading ? i + 1 : i + 2;
        ranges.push({ start: offsetForLine(lineInfo.lines, startLine), end: endLine > i + 1 ? offsetForLine(lineInfo.lines, endLine + 1) : offsetForLine(lineInfo.lines, i + 2) });
      }
      return ranges;
    }
    case "regex_single_match": {
      if (!locator.pattern) throw new Error("regex_single_match requires pattern.");
      const flags = Array.from(new Set([...(locator.flags ?? ""), "g"])).join("");
      const re = new RegExp(locator.pattern, flags);
      const ranges: Array<{ start: number; end: number }> = [];
      for (const match of content.matchAll(re)) if (match.index !== undefined) ranges.push({ start: match.index, end: match.index + match[0].length });
      return ranges;
    }
    case "exact_text": {
      if (!locator.exactText) throw new Error("exact_text requires exactText.");
      return findAllOffsets(content, locator.exactText).map((start) => ({ start, end: start + locator.exactText!.length }));
    }
  }
}

function structuredEditOutput(original: string, start: number, end: number, operation: { type: StructuredEditOperationType; content: string }): string {
  if (operation.type === "replace" || operation.type === "replace_section_body") return `${original.slice(0, start)}${operation.content}${original.slice(end)}`;
  if (operation.type === "insert_before") return `${original.slice(0, start)}${operation.content}${original.slice(start)}`;
  return `${original.slice(0, end)}${operation.content}${original.slice(end)}`;
}

export function decodeStructuredContent(input: { content: string; contentEncoding?: StructuredContentEncoding; maxDecodedBytes?: number; label?: string }): { content: string; contentEncoding: StructuredContentEncoding; decodedBytes: number } {
  const contentEncoding = input.contentEncoding ?? "plain";
  const maxDecodedBytes = input.maxDecodedBytes ?? DEFAULT_MAX_STRUCTURED_CONTENT_BYTES;
  validateLimit("maxDecodedBytes", maxDecodedBytes, DEFAULT_MAX_STRUCTURED_CONTENT_BYTES, 1, 1_000_000);
  const label = input.label ?? "content";
  const content = contentEncoding === "plain" ? input.content : decodeBase64Utf8(input.content, label);
  const decodedBytes = Buffer.byteLength(content, "utf8");
  if (decodedBytes > maxDecodedBytes) throw new Error(`${label} decoded size exceeds maxDecodedBytes: ${decodedBytes} > ${maxDecodedBytes}.`);
  return { content, contentEncoding, decodedBytes };
}

function decodeBase64Utf8(value: string, label: string): string {
  const normalized = value.replace(/\s+/g, "");
  if (normalized.length === 0 || normalized.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(normalized)) throw new Error(`${label} is not valid base64 content.`);
  const decoded = Buffer.from(normalized, "base64");
  const recoded = decoded.toString("base64");
  if (recoded !== normalized) throw new Error(`${label} is not canonical base64 content.`);
  return decoded.toString("utf8");
}

async function expandInputPaths(workspace: Workspace, paths: string[], maxFiles: number): Promise<string[]> {
  const tracked = await trackedFiles(workspace.root);
  const expanded = new Set<string>();
  for (const entry of paths) {
    const normalized = normalizeWorkspaceRelativePath(entry);
    const absolutePath = resolveWorkspaceFile(workspace, normalized);
    const stats = await stat(absolutePath).catch(() => undefined);
    if (stats?.isDirectory()) {
      const prefix = normalized.endsWith("/") ? normalized : `${normalized}/`;
      for (const file of tracked) if (file.startsWith(prefix)) expanded.add(file);
    } else {
      expanded.add(normalized);
    }
  }
  if (expanded.size > maxFiles) throw new Error(`expanded invariant file count exceeds maxFiles: ${expanded.size} > ${maxFiles}.`);
  return [...expanded];
}

async function findInvariantMatches(workspace: Workspace, files: string[], check: Exclude<InvariantCheck, { type: "structured_value_equal" }>, maxMatches: number): Promise<Array<{ path: string; line: number; text: string }>> {
  const matches: Array<{ path: string; line: number; text: string }> = [];
  const matcher = check.type === "regex_count" ? new RegExp(check.pattern, check.flags?.includes("g") ? check.flags : `${check.flags ?? ""}g`) : undefined;
  const token = check.type === "regex_count" ? undefined : check.token;
  for (const path of files) {
    const content = await readFile(resolveWorkspaceFile(workspace, path), "utf8").catch(() => "");
    const lines = splitLines(content).lines;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const hit = matcher ? matcher.test(line) : line.includes(token ?? "");
      if (matcher) matcher.lastIndex = 0;
      if (!hit) continue;
      matches.push({ path, line: i + 1, text: line.slice(0, 240) });
      if (matches.length >= maxMatches) return matches;
    }
  }
  return matches;
}

async function readStructuredValue(workspace: Workspace, path: string, pointer: string): Promise<unknown> {
  const content = await readFile(resolveWorkspaceFile(workspace, path), "utf8");
  const parsed = JSON.parse(content);
  return jsonPointer(parsed, pointer);
}

function jsonPointer(value: unknown, pointer: string): unknown {
  if (pointer === "" || pointer === "/") return value;
  let current: unknown = value;
  for (const rawPart of pointer.split("/").slice(1)) {
    const part = rawPart.replace(/~1/g, "/").replace(/~0/g, "~");
    if (current === null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function candidateForRange(content: string, lineInfo: LineInfo, start: number, end: number, occurrence: number, maxPreviewChars: number): LocatorCandidate {
  return {
    candidateId: `loc_${occurrence}`,
    lineStart: lineNumberAtOffset(lineInfo.lines, start),
    lineEnd: lineNumberAtOffset(lineInfo.lines, Math.max(start, end - 1)),
    startOffset: start,
    endOffset: end,
    selectedHash: sha256(content.slice(start, end)),
    preview: content.slice(start, end).slice(0, maxPreviewChars),
  };
}

function splitLines(content: string): LineInfo {
  const newline = content.includes("\r\n") ? "\r\n" : "\n";
  const hasFinalNewline = content.endsWith("\n");
  const normalized = content.replace(/\r\n/g, "\n");
  const raw = normalized.split("\n");
  if (raw.at(-1) === "") raw.pop();
  return { lines: raw, newline, hasFinalNewline };
}

function joinLines(lines: string[], info: LineInfo): string {
  const joined = lines.join(info.newline);
  return info.hasFinalNewline ? `${joined}${info.newline}` : joined;
}

function offsetForLine(lines: string[], line: number): number {
  return lines.slice(0, line - 1).reduce((sum, entry) => sum + entry.length + 1, 0);
}

function endOffsetForLine(lines: string[], line: number): number {
  return lines.slice(0, line).reduce((sum, entry) => sum + entry.length + 1, 0);
}

function lineNumberAtOffset(lines: string[], offset: number): number {
  let cursor = 0;
  for (let i = 0; i < lines.length; i++) {
    const next = cursor + lines[i].length + 1;
    if (offset < next) return i + 1;
    cursor = next;
  }
  return Math.max(1, lines.length);
}

function findAllOffsets(content: string, needle: string): number[] {
  const offsets: number[] = [];
  let cursor = 0;
  while (needle && cursor <= content.length) {
    const index = content.indexOf(needle, cursor);
    if (index < 0) break;
    offsets.push(index);
    cursor = index + Math.max(needle.length, 1);
  }
  return offsets;
}

function markdownHeadingLevel(value: string): number | undefined {
  const match = /^(#{1,6})\s+/.exec(value);
  return match?.[1].length;
}

function contentLineCount(value: string): number {
  if (!value) return 0;
  return value.replace(/\r\n/g, "\n").split("\n").filter((line, index, array) => index < array.length - 1 || line.length > 0).length;
}

async function trackedFiles(root: string): Promise<Set<string>> {
  const { stdout } = await git(root, ["ls-files"], { maxBuffer: 10 * 1024 * 1024 });
  return new Set(stdout.split(/\r?\n/).filter(Boolean).map((entry) => normalizeWorkspaceRelativePath(entry)));
}

function resolveWorkspaceFile(workspace: Workspace, inputPath: string): string {
  const normalized = normalizeWorkspaceRelativePath(inputPath);
  const absolute = resolve(workspace.root, normalized);
  const rel = relative(workspace.root, absolute);
  if (rel.startsWith("..") || isAbsolute(rel)) throw new Error(`Path is outside workspace root: ${inputPath}`);
  return absolute;
}

function normalizeWorkspaceRelativePath(inputPath: string): string {
  if (!inputPath || isAbsolute(inputPath)) throw new Error(`Path must be workspace-relative: ${inputPath}`);
  const normalized = inputPath.split("\\").join("/").replace(/^\.\//, "");
  if (normalized.split("/").some((part) => part === "..")) throw new Error(`Path must not contain .. segments: ${inputPath}`);
  return normalized;
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function stableJson(value: unknown): string {
  return JSON.stringify(value);
}

function validateLimit(name: string, value: number | undefined, fallback: number, min: number, max: number): void {
  const actual = value ?? fallback;
  if (!Number.isInteger(actual) || actual < min || actual > max) throw new Error(`${name} must be an integer between ${min} and ${max}.`);
}

function compactRefs(input: Record<string, string | undefined>): Record<string, string> {
  const refs: Record<string, string> = {};
  for (const [key, value] of Object.entries(input)) if (value) refs[key] = value;
  return refs;
}

function normalizeRouterLimits(limits: DevspaceRouterInput["limits"] | undefined): { maxFiles: number; maxLines: number; maxOutputChars: number; maxPreviewChars: number } {
  const maxFiles = limits?.maxFiles ?? 10;
  const maxLines = limits?.maxLines ?? 80;
  const maxOutputChars = limits?.maxOutputChars ?? 8_000;
  const maxPreviewChars = limits?.maxPreviewChars ?? 500;
  validateLimit("limits.maxFiles", maxFiles, 10, 1, 100);
  validateLimit("limits.maxLines", maxLines, 80, 1, 1000);
  validateLimit("limits.maxOutputChars", maxOutputChars, 8_000, 100, 100_000);
  validateLimit("limits.maxPreviewChars", maxPreviewChars, 500, 20, 10_000);
  return { maxFiles, maxLines, maxOutputChars, maxPreviewChars };
}

function routerResult(input: {
  input: DevspaceRouterInput;
  mode: RouterMode;
  refs: Record<string, string>;
  warnings: string[];
  summary: Record<string, unknown>;
  results: Record<string, unknown>;
  nextRecommendedAction?: string;
}): DevspaceRouterResult {
  const result = `${input.input.action}: ${input.nextRecommendedAction ?? "done"}`;
  return {
    status: "ok",
    action: input.input.action,
    mode: input.mode,
    workflowMode: input.input.workflowMode,
    refs: input.refs,
    summary: input.summary,
    results: input.results,
    nextRecommendedAction: input.nextRecommendedAction,
    warnings: input.warnings,
    runtimeInfo: getRuntimeInfo(),
    result,
  };
}

function blockedRouterResult(input: DevspaceRouterInput, mode: RouterMode, refs: Record<string, string>, warnings: string[], reason: string): DevspaceRouterResult {
  return {
    status: "blocked",
    action: input.action,
    mode,
    workflowMode: input.workflowMode,
    refs,
    summary: { reason },
    results: {},
    nextRecommendedAction: "retry_with_required_fields",
    warnings,
    runtimeInfo: getRuntimeInfo(),
    result: `blocked ${input.action}: ${reason}`,
  };
}
