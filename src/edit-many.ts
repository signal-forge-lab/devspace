import { readFile, writeFile } from "node:fs/promises";
import type { Workspace, WorkspaceRegistry } from "./workspaces.js";

export const MAX_EDIT_MANY_FILES = 20;
export const MAX_EDIT_MANY_EDITS_PER_FILE = 50;

export interface EditManyReplacementInput {
  oldText: string;
  newText: string;
}

export interface EditManyFileInput {
  path: string;
  edits: EditManyReplacementInput[];
}

export interface EditManyInput {
  files: EditManyFileInput[];
  dryRun?: boolean;
}

export interface EditManyFileResult {
  path: string;
  status: "validated" | "applied";
  editCount: number;
  additions: number;
  removals: number;
}

export interface EditManyResult extends Record<string, unknown> {
  status: "validated" | "applied";
  files: EditManyFileResult[];
  summary: {
    requestedFiles: number;
    editCount: number;
    additions: number;
    removals: number;
    dryRun: boolean;
  };
  result: string;
}

interface PlannedReplacement {
  oldText: string;
  newText: string;
  start: number;
  end: number;
}

interface PlannedFile {
  path: string;
  absolutePath: string;
  original: string;
  replacements: PlannedReplacement[];
  additions: number;
  removals: number;
}

export async function editManyFiles(
  input: EditManyInput,
  workspace: Workspace,
  workspaces: WorkspaceRegistry,
): Promise<EditManyResult> {
  const dryRun = input.dryRun ?? false;
  const plans: PlannedFile[] = [];

  for (const file of input.files) {
    const absolutePath = workspaces.resolvePath(workspace, file.path);
    const original = await readFile(absolutePath, "utf8");
    const replacements = planReplacements(file.path, original, file.edits);
    const stats = summarizeReplacements(replacements);
    plans.push({
      path: file.path,
      absolutePath,
      original,
      replacements,
      ...stats,
    });
  }

  if (!dryRun) {
    for (const plan of plans) {
      await writeFile(plan.absolutePath, applyReplacements(plan.original, plan.replacements), "utf8");
    }
  }

  const files: EditManyFileResult[] = plans.map((plan) => ({
    path: plan.path,
    status: dryRun ? "validated" : "applied",
    editCount: plan.replacements.length,
    additions: plan.additions,
    removals: plan.removals,
  }));
  const summary = {
    requestedFiles: input.files.length,
    editCount: files.reduce((total, file) => total + file.editCount, 0),
    additions: files.reduce((total, file) => total + file.additions, 0),
    removals: files.reduce((total, file) => total + file.removals, 0),
    dryRun,
  };
  const status = dryRun ? "validated" : "applied";

  return {
    status,
    files,
    summary,
    result: formatEditManyResult(status, files, summary),
  };
}

function planReplacements(
  path: string,
  original: string,
  edits: EditManyReplacementInput[],
): PlannedReplacement[] {
  const replacements = edits.map((edit, index) => {
    if (edit.oldText.length === 0) {
      throw new Error(`files[${path}].edits[${index}].oldText must not be empty.`);
    }

    const matches = findAllMatches(original, edit.oldText);
    if (matches.length !== 1) {
      throw new Error(editManyMatchError(path, index, matches.length));
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

function editManyMatchError(path: string, editIndex: number, matches: number): string {
  return [
    `files[${path}].edits[${editIndex}].oldText matched ${matches} times; expected exactly 1.`,
    "Recommended fallback:",
    "- replace_symbol for one named function/class/const target",
    "- insert_by_anchor with occurrence for repeated anchors",
    "- edit_by_line_range with expectedHash for a known line range",
    "Make oldText unique before retrying edit_many.",
  ].join("\n");
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

function summarizeReplacements(replacements: PlannedReplacement[]): {
  additions: number;
  removals: number;
} {
  return replacements.reduce(
    (summary, replacement) => ({
      additions: summary.additions + contentLineCount(replacement.newText),
      removals: summary.removals + contentLineCount(replacement.oldText),
    }),
    { additions: 0, removals: 0 },
  );
}

function contentLineCount(content: string): number {
  if (content.length === 0) return 0;
  return content.endsWith("\n")
    ? content.slice(0, -1).split("\n").length
    : content.split("\n").length;
}

function formatEditManyResult(
  status: "validated" | "applied",
  files: EditManyFileResult[],
  summary: EditManyResult["summary"],
): string {
  const action = status === "validated" ? "Validated" : "Edited";
  const suffix = status === "validated" ? " No files were changed." : "";
  const fileLines = files
    .map((file) => `- ${file.path}: ${file.editCount} edits (+${file.additions} -${file.removals})`)
    .join("\n");

  return [
    `${action} ${summary.requestedFiles} ${summary.requestedFiles === 1 ? "file" : "files"} with ${summary.editCount} ${summary.editCount === 1 ? "edit" : "edits"} (+${summary.additions} -${summary.removals}).${suffix}`,
    fileLines,
  ]
    .filter(Boolean)
    .join("\n");
}
