export type IncidentCategory =
  | "schema_validation"
  | "spawn_process_start"
  | "heredoc_or_quoting_syntax"
  | "unicode_console_output"
  | "line_range_or_locator_miss"
  | "safety_filter_block"
  | "oversized_output"
  | "unexpected_dirty_worktree"
  | "alternate_path_miss"
  | "live_side_effect_attempt"
  | "timeout"
  | "verify_failed"
  | "other_failure";

export type IncidentImprovementAction =
  | "switch_to_structured_schema"
  | "use_fixed_profile_shell_wrapper"
  | "use_structured_edit_transport"
  | "set_utf8_or_escape_output"
  | "resolve_locator_before_edit"
  | "split_sensitive_reference_from_secret_value"
  | "use_bounded_report_or_tail"
  | "inspect_status_and_scope_commit"
  | "run_alternate_execution_path_detector"
  | "require_explicit_live_smoke_flag"
  | "use_timeout_bounded_verify_profile"
  | "inspect_failure_and_choose_structured_route";

export interface IncidentClassificationInput {
  error?: string;
  message?: string;
  result?: string;
  note?: string;
  operation?: string;
  action?: string;
  tool?: string;
}

export interface IncidentClassification extends Record<string, unknown> {
  category: IncidentCategory;
  improvementAction: IncidentImprovementAction;
  improvementHint: string;
}

export function classifyIncident(input: IncidentClassificationInput): IncidentClassification {
  const haystack = [input.error, input.message, input.result, input.note, input.operation, input.action, input.tool].map((value) => String(value ?? "").toLowerCase()).join("\n");
  const category = incidentCategoryFor(haystack);
  const improvementAction = improvementActionFor(category);
  return { category, improvementAction, improvementHint: improvementHintFor(category, improvementAction) };
}

function incidentCategoryFor(haystack: string): IncidentCategory {
  if (/output validation|structured content|invalid_type|schema/.test(haystack)) return "schema_validation";
  if (/spawn|enoent|einval|process start|failed to start/.test(haystack)) return "spawn_process_start";
  if (/here-document|heredoc|unexpected eof|unterminated|syntax error|quoting/.test(haystack)) return "heredoc_or_quoting_syntax";
  if (/unicodeencodeerror|mojibake|utf-?8|console encoding|charmap/.test(haystack)) return "unicode_console_output";
  if (/(endline|line range|locator|anchor).*(miss|invalid|exceeds|matched 0|matched \d+)/.test(haystack)) return "line_range_or_locator_miss";
  if (/host|safety|blocked|filtered|policy/.test(haystack)) return "safety_filter_block";
  if (/oversized|too large|maxbuffer|truncated|output limit/.test(haystack)) return "oversized_output";
  if (/dirty worktree|working tree|uncommitted|git status/.test(haystack)) return "unexpected_dirty_worktree";
  if (/alternate path|fallback miss|entrypoint miss/.test(haystack)) return "alternate_path_miss";
  if (/live smoke|external call|chat post|notification|webhook send|authorization header/.test(haystack)) return "live_side_effect_attempt";
  if (/timed_out|timeout|sigterm|sigkill/.test(haystack)) return "timeout";
  if (/workbridge_verify|verify_/.test(haystack)) return "verify_failed";
  return "other_failure";
}

function improvementActionFor(category: IncidentCategory): IncidentImprovementAction {
  switch (category) {
    case "schema_validation": return "switch_to_structured_schema";
    case "spawn_process_start": return "use_fixed_profile_shell_wrapper";
    case "heredoc_or_quoting_syntax": return "use_structured_edit_transport";
    case "unicode_console_output": return "set_utf8_or_escape_output";
    case "line_range_or_locator_miss": return "resolve_locator_before_edit";
    case "safety_filter_block": return "split_sensitive_reference_from_secret_value";
    case "oversized_output": return "use_bounded_report_or_tail";
    case "unexpected_dirty_worktree": return "inspect_status_and_scope_commit";
    case "alternate_path_miss": return "run_alternate_execution_path_detector";
    case "live_side_effect_attempt": return "require_explicit_live_smoke_flag";
    case "timeout": return "use_timeout_bounded_verify_profile";
    case "verify_failed": return "inspect_failure_and_choose_structured_route";
    case "other_failure": return "inspect_failure_and_choose_structured_route";
  }
}

function improvementHintFor(category: IncidentCategory, action: IncidentImprovementAction): string {
  return `${category}: ${action}`;
}
