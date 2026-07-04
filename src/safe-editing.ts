import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";

export type EditRisk = "low" | "medium" | "high";
export type AnchorPosition = "before" | "after";
export type SymbolKind = "function" | "class" | "const" | "any";
export type EditTargetKind = "function" | "class" | "const" | "lines" | "insertion" | "exact_text";

export interface PlannedEditInput {
  path?: string;
  oldText?: string;
  newText?: string;
  oldChars?: number;
  newChars?: number;
  kind?: string;
}

export interface EditPlanPreflightInput {
  operation?: string;
  plannedTool?: string;
  commandShape?: string;
  targetKind?: EditTargetKind;
  symbol?: string;
  edits?: PlannedEditInput[];
}

export interface EditPlanPreflightResult extends Record<string, unknown> {
  risk: EditRisk;
  recommendedStrategy: string;
  maxEditChars: number;
  reasons: string[];
  saferTools: string[];
  result: string;
}

export interface LineRangeEditInput {
  path: string;
  absolutePath: string;
  startLine: number;
  endLine: number;
  newText: string;
  expectedHash?: string;
  dryRun?: boolean;
}

export interface AnchorInsertInput {
  path: string;
  absolutePath: string;
  anchor: string;
  position: AnchorPosition;
  content: string;
  occurrence?: number;
  dryRun?: boolean;
}

export interface SymbolReplaceInput {
  path: string;
  absolutePath: string;
  symbol: string;
  kind?: SymbolKind;
  newText: string;
  expectedHash?: string;
  dryRun?: boolean;
}

export interface SafeEditResult extends Record<string, unknown> {
  status: "validated" | "applied";
  path: string;
  additions: number;
  removals: number;
  dryRun: boolean;
  selectedHash?: string;
  matches?: number;
  result: string;
}

export interface EditPreflightIndexInput {
  path: string;
  absolutePath: string;
  startLine?: number;
  endLine?: number;
  oldText?: string;
  newText?: string;
  anchor?: string;
  symbol?: string;
  kind?: SymbolKind;
}

export interface EditPreflightIndexResult extends Record<string, unknown> {
  path: string;
  risk: EditRisk;
  lineCount: number;
  selectedHash?: string;
  selectedLines?: number;
  oldTextMatches?: number;
  anchorMatches?: number;
  symbolMatches?: number;
  additions: number;
  removals: number;
  warnings: string[];
  recommendedStrategy: string;
  result: string;
}

export interface BashPreflightInput {
  command: string;
  workingDirectory?: string;
}

export interface BashPreflightResult extends Record<string, unknown> {
  risk: EditRisk;
  reasons: string[];
  saferTools: string[];
  recommendedStrategy: string;
  result: string;
}

interface Range {
  start: number;
  end: number;
}

export function editPlanPreflight(input: EditPlanPreflightInput): EditPlanPreflightResult {
  const maxEditChars = 4_000;
  const reasons = new Set<string>();
  const saferTools = new Set<string>();
  const edits = input.edits ?? [];
  let score = 0;

  const targetKind = input.targetKind;
  const symbol = input.symbol;
  if (targetKind) {
    const targetRecommendation = targetKindRecommendation(targetKind);
    if (targetRecommendation) saferTools.add(targetRecommendation);
    reasons.add(`target_${targetKind}`);

    if (isWholeSymbolTarget(targetKind)) {
      saferTools.add("replace_symbol");
      if (symbol) reasons.add("named_symbol_target");
      if (input.plannedTool && input.plannedTool !== "replace_symbol") {
        score += 2;
        reasons.add("whole_symbol_edit_should_use_replace_symbol");
      }
    }
  }

  if (edits.length > 10) {
    score += 2;
    reasons.add("many_edits");
    saferTools.add("split into smaller single-file edits");
  }

  for (const edit of edits) {
    const oldText = edit.oldText ?? "";
    const newText = edit.newText ?? "";
    const oldChars = edit.oldChars ?? oldText.length;
    const newChars = edit.newChars ?? newText.length;
    const totalChars = oldChars + newChars;

    if (totalChars > maxEditChars) {
      score += totalChars > maxEditChars * 3 ? 3 : 2;
      reasons.add("large_edit_payload");
      saferTools.add("edit_by_line_range");
      saferTools.add("insert_by_anchor");
    }
    if (oldChars > maxEditChars) {
      score += 2;
      reasons.add("large_old_text_match");
      saferTools.add("edit_by_line_range");
      saferTools.add("replace_symbol");
    }
    if (looksLikeMixedTemplate(oldText) || looksLikeMixedTemplate(newText)) {
      score += 2;
      reasons.add("mixed_html_js_or_template_literal");
      saferTools.add("insert_by_anchor");
      saferTools.add("replace_symbol");
    }
  }

  const commandShape = input.commandShape ?? "";
  if (commandShape) {
    if (/&&|\|\||;/.test(commandShape)) {
      score += 2;
      reasons.add("compound_command_shape");
      saferTools.add("safe_operation_router");
    }
    if (/>|>>|<<|tee\b|sed\s+-i|perl\s+-i/i.test(commandShape)) {
      score += 3;
      reasons.add("shell_write_pattern");
      saferTools.add("dedicated edit/write/git tool");
    }
  }

  if ((input.plannedTool ?? "").includes("bash") && edits.length > 0) {
    score += 3;
    reasons.add("shell_for_file_edit");
    saferTools.add("edit_by_line_range");
    saferTools.add("insert_by_anchor");
  }

  const risk: EditRisk = score >= 5 ? "high" : score >= 2 ? "medium" : "low";
  const recommendedStrategy = isWholeSymbolTarget(targetKind)
    ? "replace_named_symbol"
    : targetKind === "lines"
      ? "line_range_with_hash_guard"
      : targetKind === "insertion"
        ? "anchor_insert_with_occurrence_if_needed"
        : risk === "high"
          ? "split_by_anchor_or_line_range"
          : risk === "medium"
            ? "dry_run_then_apply_small_batches"
            : "standard_edit";
  if (saferTools.size === 0) saferTools.add("edit");
  if (reasons.size === 0) reasons.add("no_obvious_risk");

  const result = [
    `Risk: ${risk}`,
    `Recommended strategy: ${recommendedStrategy}`,
    symbol ? `Target symbol: ${symbol}` : undefined,
    `Reasons: ${[...reasons].join(", ")}`,
    `Safer tools: ${[...saferTools].join(", ")}`,
  ].filter(Boolean).join("\n");

  return { risk, recommendedStrategy, maxEditChars, reasons: [...reasons], saferTools: [...saferTools], result };
}

export async function editByLineRange(input: LineRangeEditInput): Promise<SafeEditResult> {
  validateLineRange(input.startLine, input.endLine);
  const original = await readFile(input.absolutePath, "utf8");
  const lineInfo = splitLines(original);
  if (input.endLine > lineInfo.lines.length) {
    throw new Error(
      `endLine ${input.endLine} exceeds file length ${lineInfo.lines.length}. ` +
        `Retry with endLine <= ${lineInfo.lines.length}, or use resolve_locator/apply_structured_edit for changing files.`,
    );
  }

  const startIndex = lineStartOffset(lineInfo.lines, input.startLine);
  const endIndex = lineEndOffset(lineInfo.lines, input.endLine);
  const selected = original.slice(startIndex, endIndex);
  const selectedHash = shortHash(selected);
  if (input.expectedHash && input.expectedHash !== selectedHash) {
    throw new Error(`Line range hash mismatch: expected ${input.expectedHash}, actual ${selectedHash}.`);
  }

  const output = `${original.slice(0, startIndex)}${input.newText}${original.slice(endIndex)}`;
  if (!input.dryRun) await writeFile(input.absolutePath, output, "utf8");
  return editResult(input.path, input.dryRun ?? false, selected, input.newText, selectedHash);
}

export async function insertByAnchor(input: AnchorInsertInput): Promise<SafeEditResult> {
  if (!input.anchor) throw new Error("anchor must not be empty.");
  const original = await readFile(input.absolutePath, "utf8");
  const matches = findAllMatches(original, input.anchor);
  if (matches.length === 0) throw new Error("anchor matched 0 times; expected exactly 1 or provide occurrence.");
  const occurrence = input.occurrence;
  if (occurrence !== undefined && (!Number.isInteger(occurrence) || occurrence < 1)) {
    throw new Error("occurrence must be a positive integer when provided.");
  }
  if (occurrence === undefined && matches.length !== 1) {
    throw new Error(`anchor matched ${matches.length} times; expected exactly 1 or provide occurrence.`);
  }
  const matchIndex = occurrence === undefined ? matches[0] : matches[occurrence - 1];
  if (matchIndex === undefined) throw new Error(`occurrence ${occurrence} exceeds match count ${matches.length}.`);
  const insertAt = input.position === "before" ? matchIndex : matchIndex + input.anchor.length;
  const output = `${original.slice(0, insertAt)}${input.content}${original.slice(insertAt)}`;
  if (!input.dryRun) await writeFile(input.absolutePath, output, "utf8");
  return { ...editResult(input.path, input.dryRun ?? false, "", input.content), matches: matches.length };
}

export async function replaceSymbol(input: SymbolReplaceInput): Promise<SafeEditResult> {
  if (!/^[$A-Z_a-z][$\w]*$/.test(input.symbol)) throw new Error(`Invalid symbol name: ${input.symbol}`);
  const original = await readFile(input.absolutePath, "utf8");
  const ranges = findSymbolRanges(original, input.symbol, input.kind ?? "any");
  if (ranges.length !== 1) {
    throw new Error(`symbol ${input.symbol} matched ${ranges.length} ranges; expected exactly 1.`);
  }
  const range = ranges[0];
  const selected = original.slice(range.start, range.end);
  const selectedHash = shortHash(selected);
  if (input.expectedHash && input.expectedHash !== selectedHash) {
    throw new Error(`Symbol range hash mismatch: expected ${input.expectedHash}, actual ${selectedHash}.`);
  }
  const output = `${original.slice(0, range.start)}${input.newText}${original.slice(range.end)}`;
  if (!input.dryRun) await writeFile(input.absolutePath, output, "utf8");
  return editResult(input.path, input.dryRun ?? false, selected, input.newText, selectedHash);
}

export async function editPreflightIndex(input: EditPreflightIndexInput): Promise<EditPreflightIndexResult> {
  const original = await readFile(input.absolutePath, "utf8");
  const lineInfo = splitLines(original);
  const warnings = new Set<string>();
  let selectedHash: string | undefined;
  let selectedLines: number | undefined;
  let removals = 0;

  if ((input.startLine === undefined) !== (input.endLine === undefined)) {
    throw new Error("startLine and endLine must be provided together.");
  }
  if (input.startLine !== undefined && input.endLine !== undefined) {
    validateLineRange(input.startLine, input.endLine);
    if (input.endLine > lineInfo.lines.length) {
      throw new Error(`endLine ${input.endLine} exceeds file length ${lineInfo.lines.length}.`);
    }
    const startIndex = lineStartOffset(lineInfo.lines, input.startLine);
    const endIndex = lineEndOffset(lineInfo.lines, input.endLine);
    const selected = original.slice(startIndex, endIndex);
    selectedHash = shortHash(selected);
    selectedLines = input.endLine - input.startLine + 1;
    removals = contentLineCount(selected);
  }

  const oldTextMatches = input.oldText ? findAllMatches(original, input.oldText).length : undefined;
  if (oldTextMatches === 0) warnings.add("old_text_not_found");
  if ((oldTextMatches ?? 1) > 1) warnings.add("old_text_not_unique");

  const anchorMatches = input.anchor ? findAllMatches(original, input.anchor).length : undefined;
  if (anchorMatches === 0) warnings.add("anchor_not_found");
  if ((anchorMatches ?? 1) > 1) warnings.add("anchor_not_unique");

  const symbolMatches = input.symbol ? findSymbolRanges(original, input.symbol, input.kind ?? "any").length : undefined;
  if (symbolMatches === 0) warnings.add("symbol_not_found");
  if ((symbolMatches ?? 1) > 1) warnings.add("symbol_not_unique");

  const additions = contentLineCount(input.newText ?? "");
  if ((input.newText ?? "").length > 4000) warnings.add("large_new_text");
  if (input.startLine === undefined && !input.oldText && !input.anchor && !input.symbol) warnings.add("no_target_check");

  const risk = warnings.size >= 2 ? "high" : warnings.size === 1 ? "medium" : "low";
  const recommendedStrategy = input.symbol
    ? "replace_symbol_with_hash_guard"
    : input.anchor
      ? "anchor_insert_with_occurrence_guard"
      : input.startLine !== undefined
        ? "edit_by_line_range_with_expected_hash"
        : "exact_edit_with_unique_match";

  const result = [
    `edit_preflight_index ${input.path}: risk=${risk}`,
    selectedHash ? `selectedHash=${selectedHash} selectedLines=${selectedLines}` : undefined,
    oldTextMatches !== undefined ? `oldTextMatches=${oldTextMatches}` : undefined,
    anchorMatches !== undefined ? `anchorMatches=${anchorMatches}` : undefined,
    symbolMatches !== undefined ? `symbolMatches=${symbolMatches}` : undefined,
    `lineCount=${lineInfo.lines.length} +${additions} -${removals}`,
    `recommended=${recommendedStrategy}`,
    warnings.size > 0 ? `warnings=${[...warnings].join(",")}` : "warnings=none",
  ].filter(Boolean).join("\n");

  return {
    path: input.path,
    risk,
    lineCount: lineInfo.lines.length,
    selectedHash,
    selectedLines,
    oldTextMatches,
    anchorMatches,
    symbolMatches,
    additions,
    removals,
    warnings: [...warnings],
    recommendedStrategy,
    result,
  };
}

export function bashPreflight(input: BashPreflightInput): BashPreflightResult {
  const command = input.command.trim();
  const reasons = new Set<string>();
  const saferTools = new Set<string>();
  let score = 0;

  if (!command) {
    reasons.add("empty_command");
    saferTools.add("no-op");
    score += 1;
  }
  if (command.length > 500) {
    reasons.add("long_command");
    saferTools.add("split_into_smaller_steps");
    score += 2;
  }
  if (/&&|\|\||;/.test(command)) {
    reasons.add("compound_command");
    saferTools.add("single_purpose_tool_call");
    score += 2;
  }
  if (/<<|\btee\b|>|>>|sed\s+-i|perl\s+-i/i.test(command)) {
    reasons.add("shell_write_or_heredoc_pattern");
    saferTools.add("edit_by_line_range");
    saferTools.add("edit");
    score += 3;
  }
  if (/\bgit\s+diff\b/i.test(command)) {
    reasons.add("git_diff_via_shell");
    saferTools.add("git_diff_ranges");
    score += 2;
  }
  if (/\bgit\s+(add|commit|reset|checkout|clean)\b/i.test(command)) {
    reasons.add("git_mutation_via_shell");
    saferTools.add("git_commit_files");
    score += 3;
  }
  if (/\bnpm\s+(test|run\s+test)\b/i.test(command)) {
    reasons.add("broad_test_command");
    saferTools.add("focused_test_or_typecheck");
    score += 1;
  }
  if (/\b(sed|nl|cat)\b.*\b(src|docs|README|package)\b/i.test(command) || /\brg\b|\bgrep\b/i.test(command)) {
    reasons.add("shell_read_or_search_pattern");
    saferTools.add("grep_context");
    saferTools.add("read_index_ranges");
    score += 1;
  }
  if (/`|\$\(/.test(command)) {
    reasons.add("command_substitution");
    saferTools.add("avoid_shell_substitution");
    score += 2;
  }

  if (reasons.size === 0) reasons.add("no_obvious_risk");
  if (saferTools.size === 0) saferTools.add("bash");
  const risk: EditRisk = score >= 5 ? "high" : score >= 2 ? "medium" : "low";
  const recommendedStrategy = risk === "high"
    ? "replace_with_dedicated_workspace_tool"
    : risk === "medium"
      ? "simplify_or_preflight_before_bash"
      : "bash_ok";
  const result = [
    `bash_preflight risk=${risk}`,
    `recommended=${recommendedStrategy}`,
    `reasons=${[...reasons].join(",")}`,
    `saferTools=${[...saferTools].join(",")}`,
  ].join("\n");
  return { risk, reasons: [...reasons], saferTools: [...saferTools], recommendedStrategy, result };
}

function isWholeSymbolTarget(targetKind: EditTargetKind | undefined): boolean {
  return targetKind === "function" || targetKind === "class" || targetKind === "const";
}

function targetKindRecommendation(targetKind: EditTargetKind): string {
  switch (targetKind) {
    case "function":
    case "class":
    case "const":
      return "replace_symbol";
    case "lines":
      return "edit_by_line_range";
    case "insertion":
      return "insert_by_anchor";
    case "exact_text":
      return "edit";
  }
}

function findSymbolRanges(text: string, symbol: string, kind: SymbolKind): Range[] {
  const candidates: Range[] = [];
  if (kind === "function" || kind === "any") candidates.push(...findJsFunctionRanges(text, symbol), ...findPythonDefRanges(text, symbol));
  if (kind === "class" || kind === "any") candidates.push(...findJsClassRanges(text, symbol));
  if (kind === "const" || kind === "any") candidates.push(...findJsVariableRanges(text, symbol));
  return candidates.sort((a, b) => a.start - b.start);
}

function findJsFunctionRanges(text: string, symbol: string): Range[] {
  const ranges: Range[] = [];
  const re = new RegExp(`(^|\\n)(export\\s+)?(async\\s+)?function\\s+${escapeRegExp(symbol)}\\s*\\(`, "g");
  for (const match of text.matchAll(re)) {
    const start = (match.index ?? 0) + (match[1] ? match[1].length : 0);
    const brace = text.indexOf("{", start);
    if (brace !== -1) ranges.push({ start, end: findMatchingBrace(text, brace) + 1 });
  }
  return ranges;
}

function findJsClassRanges(text: string, symbol: string): Range[] {
  const ranges: Range[] = [];
  const re = new RegExp(`(^|\\n)(export\\s+)?class\\s+${escapeRegExp(symbol)}\\b`, "g");
  for (const match of text.matchAll(re)) {
    const start = (match.index ?? 0) + (match[1] ? match[1].length : 0);
    const brace = text.indexOf("{", start);
    if (brace !== -1) ranges.push({ start, end: findMatchingBrace(text, brace) + 1 });
  }
  return ranges;
}

function findJsVariableRanges(text: string, symbol: string): Range[] {
  const ranges: Range[] = [];
  const re = new RegExp(`(^|\\n)(export\\s+)?(const|let|var)\\s+${escapeRegExp(symbol)}\\b`, "g");
  for (const match of text.matchAll(re)) {
    const start = (match.index ?? 0) + (match[1] ? match[1].length : 0);
    ranges.push({ start, end: findStatementEnd(text, start) });
  }
  return ranges;
}

function findPythonDefRanges(text: string, symbol: string): Range[] {
  const lines = text.split(/(?<=\n)/);
  const ranges: Range[] = [];
  let offset = 0;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    const match = line.match(new RegExp(`^(\\s*)def\\s+${escapeRegExp(symbol)}\\s*\\(`));
    if (!match) {
      offset += line.length;
      continue;
    }
    const indent = match[1]?.length ?? 0;
    let end = offset + line.length;
    for (let j = i + 1, innerOffset = end; j < lines.length; j += 1) {
      const next = lines[j] ?? "";
      if (next.trim() && leadingSpaces(next) <= indent) break;
      end = innerOffset + next.length;
      innerOffset += next.length;
    }
    ranges.push({ start: offset, end });
    offset += line.length;
  }
  return ranges;
}

function findMatchingBrace(text: string, openIndex: number): number {
  let depth = 0;
  let quote: string | undefined;
  let escaped = false;
  for (let i = openIndex; i < text.length; i += 1) {
    const char = text[i];
    if (quote) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === quote) quote = undefined;
      continue;
    }
    if (char === "'" || char === '"' || char === "`") {
      quote = char;
      continue;
    }
    if (char === "{") depth += 1;
    if (char === "}") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  throw new Error("Could not find matching closing brace.");
}

function findStatementEnd(text: string, start: number): number {
  const semicolon = text.indexOf(";", start);
  if (semicolon !== -1) return semicolon + 1;
  const newline = text.indexOf("\n", start);
  return newline === -1 ? text.length : newline + 1;
}

function editResult(path: string, dryRun: boolean, oldText: string, newText: string, selectedHash?: string): SafeEditResult {
  const status = dryRun ? "validated" : "applied";
  const additions = contentLineCount(newText);
  const removals = contentLineCount(oldText);
  return {
    status,
    path,
    additions,
    removals,
    dryRun,
    selectedHash,
    result: `${status === "validated" ? "Validated" : "Edited"} ${path} (+${additions} -${removals}).${dryRun ? " No file was changed." : ""}`,
  };
}

function splitLines(text: string): { lines: string[] } {
  return { lines: text.split(/(?<=\n)/) };
}

function lineStartOffset(lines: string[], line: number): number {
  return lines.slice(0, line - 1).reduce((total, item) => total + item.length, 0);
}

function lineEndOffset(lines: string[], line: number): number {
  return lines.slice(0, line).reduce((total, item) => total + item.length, 0);
}

function validateLineRange(startLine: number, endLine: number): void {
  if (!Number.isInteger(startLine) || startLine < 1) throw new Error("startLine must be a positive integer.");
  if (!Number.isInteger(endLine) || endLine < startLine) throw new Error("endLine must be greater than or equal to startLine.");
}

function findAllMatches(text: string, needle: string): number[] {
  const matches: number[] = [];
  let cursor = 0;
  while (cursor <= text.length) {
    const index = text.indexOf(needle, cursor);
    if (index === -1) break;
    matches.push(index);
    cursor = index + Math.max(needle.length, 1);
  }
  return matches;
}

function looksLikeMixedTemplate(text: string): boolean {
  return /<\/?[A-Za-z][^>]*>/.test(text) && /`|\$\{|<script|function\s|=>|const\s|let\s|var\s/i.test(text);
}

function contentLineCount(content: string): number {
  if (content.length === 0) return 0;
  return content.endsWith("\n") ? content.slice(0, -1).split("\n").length : content.split("\n").length;
}

function shortHash(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 12);
}

function leadingSpaces(line: string): number {
  return line.match(/^\s*/)?.[0].length ?? 0;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
