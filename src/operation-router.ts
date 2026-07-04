import { classifyWorkbridgeEfficiency, type WorkbridgeEfficiencyClassification } from "./workbridge-efficiency-classifier.js";

export type OperationRisk = "low" | "medium" | "high";
export type OperationTargetKind = "function" | "class" | "const" | "lines" | "insertion" | "exact_text";
export type WorkbridgeToolMode = "minimal" | "full" | "codex";

export interface SafeOperationRouteInput {
  intent?: string;
  plannedTool?: string;
  operation?: string;
  commandShape?: string;
  fileCount?: number;
  editCharacters?: number;
  writesFiles?: boolean;
  usesGit?: boolean;
  taskClass?: WorkbridgeEfficiencyClassification["taskClass"];
  secretValueHandling?: "never_read_or_write" | "mock_only";
  envVarReferences?: string[];
  liveSmokeRequested?: boolean;
  externalSideEffect?: boolean;
  incident?: string;
  targetKind?: OperationTargetKind;
  symbol?: string;
  toolMode?: WorkbridgeToolMode;
}

export interface SafeOperationRouteResult extends Record<string, unknown> {
  risk: OperationRisk;
  recommendedTool: string;
  strategy: string;
  reasons: string[];
  warnings: string[];
  taskClass: WorkbridgeEfficiencyClassification["taskClass"];
  efficiencyGoal: string;
  recommendedSequence: string[];
  requiredChecks: string[];
  transportRecommendation: WorkbridgeEfficiencyClassification["transportRecommendation"];
  blockedPattern: string;
  improvementHint: string;
  result: string;
}

export function routeSafeOperation(input: SafeOperationRouteInput): SafeOperationRouteResult {
  const reasons: string[] = [];
  const warnings: string[] = [];
  let riskScore = 0;
  let recommendedTool = input.plannedTool || "edit";
  let strategy = "proceed_with_standard_tool";
  const intent = `${input.intent ?? ""} ${input.operation ?? ""}`.toLowerCase();
  const commandShape = input.commandShape ?? "";
  const routeText = `${intent} ${commandShape}`.toLowerCase();
  const codexPatchRequested = /apply_patch|codex patch|\*\*\* begin patch|begin patch|delete file|move file|rename file/.test(routeText);
  const guardedPatchRequested = /apply_unified_patch|expectedbase|sha256|hash[- ]?guard|guarded unified|unified diff/.test(routeText);
  const processSessionRequested = /exec_command|write_stdin|long[- ]?running|interactive|pty|session|poll|ctrl[- ]?c|stdin/.test(routeText);
  const efficiency = classifyWorkbridgeEfficiency(input);

  if (input.targetKind) {
    reasons.push(`target_${input.targetKind}`);
    if (isWholeSymbolTarget(input.targetKind)) {
      recommendedTool = "replace_symbol";
      strategy = "replace_named_symbol";
      if (input.symbol) reasons.push("named_symbol_target");
      if (input.plannedTool && input.plannedTool !== "replace_symbol") {
        riskScore += 2;
        warnings.push("Whole function/class/const edits should use replace_symbol instead of line-range or exact-text replacement.");
      }
    } else if (input.targetKind === "lines") {
      recommendedTool = "edit_by_line_range";
      strategy = "line_range_with_hash_guard";
    } else if (input.targetKind === "insertion") {
      recommendedTool = "insert_by_anchor";
      strategy = "anchor_insert_with_occurrence_if_needed";
    } else if (input.targetKind === "exact_text") {
      recommendedTool = "edit";
      strategy = "exact_text_unique_match";
    }
  }

  if (input.usesGit || /git\s+/.test(commandShape) || intent.includes("commit") || intent.includes("stage")) {
    const stagedWorkflow = intent.includes("hunk") || intent.includes("staged") || intent.includes("stage_hunks") || intent.includes("partial");
    const statusOnly = intent.includes("status") || intent.includes("log") || intent.includes("recent");
    recommendedTool = stagedWorkflow
      ? "git_stage_hunks/git_stage_files + git_commit_staged"
      : statusOnly
        ? "workspace_snapshot first, then git_status/git_recent_commits if needed"
        : "git_commit_files";
    strategy = stagedWorkflow ? "use_staged_git_workflow_only_when_required" : "prefer_commit_files_then_stage_fallback";
    reasons.push("git_operation");
    if (intent.includes("stage") && !stagedWorkflow) {
      warnings.push("Prefer git_commit_files over separate staging unless an explicit staged workflow is required or git_commit_files was filtered in this thread.");
    }
    if (!statusOnly && !stagedWorkflow) {
      warnings.push("If git_commit_files is filtered, fall back once to git_stage_files + git_commit_staged; stop if that also cannot be used.");
    }
    if (/&&|;/.test(commandShape)) {
      riskScore += 2;
      warnings.push("Avoid compound git shell commands; use dedicated Git tools.");
    }
  }

  if (codexPatchRequested) {
    recommendedTool = "apply_patch";
    strategy = "codex_patch_format_add_update_delete_move";
    reasons.push("codex_patch_requested");
    if (input.toolMode !== "codex") {
      warnings.push("apply_patch is available in codex tool mode; switch to DEVSPACE_TOOL_MODE=codex or use apply_unified_patch / structured Workbridge edit tools in other modes.");
    }
  } else if (guardedPatchRequested) {
    recommendedTool = "apply_unified_patch";
    strategy = "hash_guarded_unified_diff";
    reasons.push("hash_guarded_patch_requested");
  }

  if ((input.writesFiles || /edit|write|modify|replace|insert/.test(intent)) && !codexPatchRequested && !guardedPatchRequested) {
    if (isWholeSymbolTarget(input.targetKind)) {
      recommendedTool = "replace_symbol";
      strategy = "replace_named_symbol";
      reasons.push("whole_symbol_edit");
    } else if (input.targetKind === "insertion") {
      recommendedTool = "insert_by_anchor";
      strategy = "anchor_insert_with_occurrence_if_needed";
      reasons.push("targeted_insertion");
    } else if (input.targetKind === "lines") {
      recommendedTool = "edit_by_line_range";
      strategy = "line_range_with_hash_guard";
      reasons.push("line_range_edit");
    } else if ((input.editCharacters ?? 0) > 4_000) {
      recommendedTool = "edit_by_line_range or insert_by_anchor";
      strategy = "split_large_edit_before_applying";
      riskScore += 3;
      reasons.push("large_write_payload");
    } else if ((input.fileCount ?? 0) > 1) {
      recommendedTool = "edit";
      strategy = "apply_small_single_file_edits";
      riskScore += 1;
      reasons.push("multi_file_edit");
    } else {
      recommendedTool = "edit";
      strategy = "targeted_exact_replacement";
      reasons.push("single_file_edit");
    }
  }

  const readRoute = classifyReadRoute(input, intent, commandShape);
  if (readRoute === "known_small_indexed_read") {
    recommendedTool = "read_index_ranges";
    strategy = "small_known_ranges_indexed_read";
    riskScore += 1;
    reasons.push("known_files_small_ranges");
    warnings.push("Use a small indexed range read. If unavailable, switch to ZIP-first before any legacy direct reads.");
  } else if (readRoute === "zip_first") {
    recommendedTool = "export_workspace_zip + create_zip_download_url";
    strategy = "zip_first_read_then_mcp_writes";
    riskScore += 2;
    reasons.push("read_heavy_or_broad_search");
    warnings.push("Use ZIP-first before broad read/search; if ZIP download/extraction fails, shrink to grep_context/file_outline/focused read and report the ZIP failure.");
  }

  if (/npm\s+(run\s+)?test|typecheck|tsc|pytest|cargo\s+test|go\s+test/.test(commandShape) || intent.includes("test") || intent.includes("validate")) {
    recommendedTool = processSessionRequested || input.toolMode === "codex" ? "exec_command" : "bash";
    strategy = processSessionRequested || input.toolMode === "codex" ? "run_validation_as_process_session" : "run_one_validation_command_at_a_time";
    reasons.push("validation_command");
    if (/&&|;/.test(commandShape)) {
      riskScore += 2;
      warnings.push("Split validation commands instead of chaining them.");
    }
  }

  if (processSessionRequested && !reasons.includes("validation_command")) {
    recommendedTool = "exec_command + write_stdin";
    strategy = "use_resumable_process_session";
    reasons.push("process_session_requested");
    if (input.toolMode !== "codex") {
      warnings.push("exec_command/write_stdin are codex-mode process tools; use DEVSPACE_TOOL_MODE=codex or keep bash bounded in minimal/full mode.");
    }
  }

  if (/<<|heredoc/i.test(commandShape)) {
    riskScore += 3;
    reasons.push("shell_heredoc_shape");
    warnings.push("Avoid shell heredocs, including read-only Python heredocs; use focused read/grep_context/file_outline or a simple node -e when needed.");
  }

  if (/>|>>|<<|\btee\b|sed\s+-i|perl\s+-i/i.test(commandShape)) {
    riskScore += 4;
    recommendedTool = input.usesGit ? recommendedTool : "write/edit_by_line_range/insert_by_anchor";
    strategy = "avoid_shell_write_shape";
    reasons.push("shell_write_shape");
    warnings.push("Do not use shell redirection or in-place shell edits for project file changes.");
  }

  if (!codexPatchRequested && !guardedPatchRequested && (input.plannedTool ?? "").includes("bash") && (input.writesFiles || /write|edit|replace/.test(intent))) {
    riskScore += 3;
    recommendedTool = isWholeSymbolTarget(input.targetKind) ? "replace_symbol" : "edit_by_line_range or insert_by_anchor";
    strategy = "route_shell_write_to_edit_tool";
    reasons.push("bash_for_file_edit");
  }

  if (reasons.length === 0) reasons.push("no_special_routing_needed");
  const legacyRisk: OperationRisk = riskScore >= 4 ? "high" : riskScore >= 2 ? "medium" : "low";
  const risk = maxRisk(legacyRisk, efficiency.risk);
  const result = [
    `Risk: ${risk}`,
    `Task class: ${efficiency.taskClass}`,
    `Recommended tool: ${recommendedTool}`,
    `Strategy: ${strategy}`,
    `Efficiency goal: ${efficiency.efficiencyGoal}`,
    input.symbol ? `Target symbol: ${input.symbol}` : undefined,
    `Recommended sequence: ${efficiency.recommendedSequence.join(" -> ")}`,
    `Reasons: ${reasons.join(", ")}`,
    warnings.length ? `Warnings: ${warnings.join(" ")}` : undefined,
  ].filter(Boolean).join("\n");

  return {
    risk,
    recommendedTool,
    strategy,
    reasons,
    warnings,
    taskClass: efficiency.taskClass,
    efficiencyGoal: efficiency.efficiencyGoal,
    recommendedSequence: efficiency.recommendedSequence,
    requiredChecks: efficiency.requiredChecks,
    transportRecommendation: efficiency.transportRecommendation,
    blockedPattern: efficiency.blockedPattern,
    improvementHint: efficiency.improvementHint,
    result,
  };
}

function maxRisk(left: OperationRisk, right: OperationRisk): OperationRisk {
  const score: Record<OperationRisk, number> = { low: 0, medium: 1, high: 2 };
  return score[left] >= score[right] ? left : right;
}

function classifyReadRoute(input: SafeOperationRouteInput, intent: string, commandShape: string): "known_small_indexed_read" | "zip_first" | undefined {
  const plannedTool = input.plannedTool ?? "";
  const fileCount = input.fileCount ?? 0;
  const knownSmallIntent = /known files|known ranges|small ranges|focused ranges|specific ranges/.test(intent);
  const broadReadIntent = /read-heavy|read heavy|broad read|broad search|repo search|repository search|residue|sweep|version sweep|many function|large file/.test(intent);
  const broadReadTool = /grep_context|rg|grep/.test(plannedTool) || /\b(rg|grep)\b/.test(commandShape);
  const readManyPlanned = /read_many/.test(plannedTool);
  const longSearch = /\b(rg|grep)\b/.test(commandShape) && commandShape.length > 120;
  if (knownSmallIntent && fileCount > 1 && !broadReadIntent && !broadReadTool && !longSearch) return "known_small_indexed_read";
  if (fileCount >= 3 || broadReadIntent || broadReadTool || readManyPlanned || longSearch) return "zip_first";
  return undefined;
}

function isWholeSymbolTarget(targetKind: OperationTargetKind | undefined): boolean {
  return targetKind === "function" || targetKind === "class" || targetKind === "const";
}
