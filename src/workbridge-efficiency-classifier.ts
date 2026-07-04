export type WorkbridgeTaskClass =
  | "read_inspect"
  | "small_edit"
  | "large_edit_refactor"
  | "validation_test"
  | "structured_sensitive_integration"
  | "runtime_external_side_effect"
  | "packaging_release"
  | "incident_recovery";

export type WorkbridgeEfficiencyRisk = "low" | "medium" | "high";
export type StructuredEditTransportRecommendation = "none" | "plain_structured_edit" | "base64_structured_edit" | "unified_patch_with_hash_guard";

export interface WorkbridgeEfficiencyClassifierInput {
  intent?: string;
  operation?: string;
  plannedTool?: string;
  commandShape?: string;
  fileCount?: number;
  editCharacters?: number;
  writesFiles?: boolean;
  usesGit?: boolean;
  taskClass?: WorkbridgeTaskClass;
  secretValueHandling?: "never_read_or_write" | "mock_only";
  envVarReferences?: string[];
  liveSmokeRequested?: boolean;
  externalSideEffect?: boolean;
  incident?: string;
}

export interface WorkbridgeEfficiencyClassification extends Record<string, unknown> {
  taskClass: WorkbridgeTaskClass;
  risk: WorkbridgeEfficiencyRisk;
  efficiencyGoal: string;
  recommendedSequence: string[];
  requiredChecks: string[];
  transportRecommendation: StructuredEditTransportRecommendation;
  blockedPattern: string;
  improvementHint: string;
}

export function classifyWorkbridgeEfficiency(input: WorkbridgeEfficiencyClassifierInput): WorkbridgeEfficiencyClassification {
  const text = `${input.intent ?? ""} ${input.operation ?? ""} ${input.plannedTool ?? ""} ${input.commandShape ?? ""}`.toLowerCase();
  const taskClass = input.taskClass ?? inferTaskClass(input, text);
  return classificationForTaskClass(taskClass, input, text);
}

function inferTaskClass(input: WorkbridgeEfficiencyClassifierInput, text: string): WorkbridgeTaskClass {
  if (input.incident || /incident|blocked|filter|heredoc|stream error|retry|failure/.test(text)) return "incident_recovery";
  if (input.externalSideEffect || input.liveSmokeRequested || /post|notify|deploy|live smoke|external service|webhook call|send message/.test(text)) return "runtime_external_side_effect";
  if (input.secretValueHandling || (input.envVarReferences?.length ?? 0) > 0 || /env var|api key|secret|token|authorization|credential|webhook/.test(text)) return "structured_sensitive_integration";
  if (input.usesGit || /version|package\.json|package-lock|release|publish|commit|package metadata/.test(text)) return "packaging_release";
  if (/test|typecheck|validate|smoke|verify|build/.test(text) && !input.writesFiles) return "validation_test";
  if (hasLargeEditRefactorSignal(text)) return "large_edit_refactor";
  if (!input.writesFiles && /inspect|read|search|residue|sweep|context/.test(text)) return "read_inspect";
  if ((input.fileCount ?? 0) >= 3 || (input.editCharacters ?? 0) > 4_000 || /refactor|rewrite|multi-file|large edit/.test(text)) return "large_edit_refactor";
  if (input.writesFiles || /edit|modify|replace|insert|patch/.test(text)) return "small_edit";
  return "read_inspect";
}

function hasLargeEditRefactorSignal(text: string): boolean {
  const structuralWork = /\b(split|refactor|rewrite|reorganize|restructure|extract|move|rename|migrate)\b/.test(text);
  const structuralTarget = /\b(module|entry\s*path|entrypoint|fallback\s*path|bootstrap|injection|runtime\s*path|cli\s*path|config\s*path|popup|ui|multi[- ]?file)\b/.test(text);
  const changeIntent = /\b(update|change|modify|edit|implement|apply|fix|replace|split|extract|move|rename|migrate|refactor|rewrite|reorganize|restructure)\b/.test(text);
  const explicitLargeChange = /\b(module\s+split|large\s+(change|edit|refactor)|multi[- ]?file\s+(change|edit|refactor)|entry\s*path|fallback\s*path)\b/.test(text);
  return changeIntent && (explicitLargeChange || (structuralWork && structuralTarget));
}

function classificationForTaskClass(taskClass: WorkbridgeTaskClass, input: WorkbridgeEfficiencyClassifierInput, text: string): WorkbridgeEfficiencyClassification {
  switch (taskClass) {
    case "structured_sensitive_integration":
      return {
        taskClass,
        risk: input.liveSmokeRequested ? "high" : "medium",
        efficiencyGoal: "separate_secret_reference_from_secret_value_and_generate_config_mock_first",
        recommendedSequence: [
          "classify",
          "validate_env_var_reference",
          "structured_env_reference_patch",
          "mock_test",
          "workbridge_verify:typecheck_only",
          "workbridge_verify:git_diff_check",
        ],
        requiredChecks: ["env_var_name_validation", "no_secret_value_input", "mock_or_config_only_default", "no_secret_value_logged"],
        transportRecommendation: "plain_structured_edit",
        blockedPattern: "live_secret_value_or_live_api_call_in_first_step",
        improvementHint: "use typed env var reference rather than free-form source insertion",
      };
    case "large_edit_refactor":
      return {
        taskClass,
        risk: "high",
        efficiencyGoal: "move_large_or_multi_file_change_to_hash_guarded_patch_batches",
        recommendedSequence: ["classify", "inspect_targets", "resolve_locator_or_prepare_patch", "dry_run_patch", "apply_patch", "workbridge_verify:typecheck_only", "workbridge_verify:build"],
        requiredChecks: ["expected_base_hash", "dry_run_result", "alternate_execution_path_inventory", "git_diff_check"],
        transportRecommendation: text.includes("template") || (input.editCharacters ?? 0) > 20_000 ? "base64_structured_edit" : "unified_patch_with_hash_guard",
        blockedPattern: "large_heredoc_or_shell_generated_rewrite",
        improvementHint: "use structured transport with decoded size validation and hash guards",
      };
    case "validation_test":
      return {
        taskClass,
        risk: "low",
        efficiencyGoal: "use_fixed_verify_profiles_with_bounded_output",
        recommendedSequence: ["classify", "workbridge_verify:git_status_check", "workbridge_verify:related_profile", "summarize"],
        requiredChecks: ["profile_selected", "bounded_output", "failure_tail_only_when_needed"],
        transportRecommendation: "none",
        blockedPattern: "combined_validation_shell_chain",
        improvementHint: "split validation into fixed workbridge_verify profiles",
      };
    case "runtime_external_side_effect":
      return {
        taskClass,
        risk: "high",
        efficiencyGoal: "keep_runtime_side_effects_config_only_until_explicit_live_approval",
        recommendedSequence: ["classify", "config_or_dry_run_change", "mock_test", "record_unexecuted_live_step", "workbridge_verify:git_diff_check"],
        requiredChecks: ["explicit_live_approval_absent_or_present", "no_secret_value_logged", "local_state_only_verification"],
        transportRecommendation: "plain_structured_edit",
        blockedPattern: "implicit_live_external_call_or_chat_posting",
        improvementHint: "separate config/mock workflow from live smoke execution flag",
      };
    case "packaging_release":
      return {
        taskClass,
        risk: "medium",
        efficiencyGoal: "update_package_metadata_consistently_then_verify_build",
        recommendedSequence: ["classify", "update_package_json_and_lock", "workbridge_verify:typecheck_only", "workbridge_verify:build", "workbridge_verify:git_diff_check"],
        requiredChecks: ["package_version_consistency", "typecheck_or_build", "no_generated_archive_unless_requested"],
        transportRecommendation: "plain_structured_edit",
        blockedPattern: "publish_or_push_without_explicit_request",
        improvementHint: "treat package metadata as structured values and keep publish separate",
      };
    case "incident_recovery":
      return {
        taskClass,
        risk: "high",
        efficiencyGoal: "convert_failed_route_into_next_structured_workflow_choice",
        recommendedSequence: ["classify_incident", "stop_same_shape_retry", "choose_safer_transport", "record_workflow_event", "verify_recovery_path"],
        requiredChecks: ["incident_category", "failed_route", "replacement_route", "bounded_retry_count"],
        transportRecommendation: /heredoc|encoding|large/.test(text) ? "base64_structured_edit" : "plain_structured_edit",
        blockedPattern: "repeating_same_filtered_or_brittle_shape",
        improvementHint: "record the reusable DevSpace improvement instead of treating the incident as a task stop",
      };
    case "small_edit":
      return {
        taskClass,
        risk: "low",
        efficiencyGoal: "apply_focused_locator_edit_then_minimal_verification",
        recommendedSequence: ["classify", "resolve_locator", "apply_structured_edit:dry_run", "apply_structured_edit", "workbridge_verify:git_diff_check"],
        requiredChecks: ["locator_match_count", "expected_sha256", "dry_run_result"],
        transportRecommendation: "plain_structured_edit",
        blockedPattern: "broad_line_range_or_shell_write_for_small_change",
        improvementHint: "use locator plus hash guard for focused changes",
      };
    case "read_inspect":
      return {
        taskClass,
        risk: (input.fileCount ?? 0) >= 3 ? "medium" : "low",
        efficiencyGoal: "gather_bounded_context_with_snapshot_or_focused_ranges",
        recommendedSequence: ["classify", "workspace_snapshot_or_router_snapshot", "focused_inspect", "summarize_findings"],
        requiredChecks: ["bounded_output", "workspace_boundary", "no_private_runtime_artifact_read"],
        transportRecommendation: "none",
        blockedPattern: "repeated_broad_reads_before_snapshot_or_zip_first",
        improvementHint: "switch to ZIP-first or indexed ranges when read scope expands",
      };
  }
}
