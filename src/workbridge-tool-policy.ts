export const WORKBRIDGE_UPSTREAM_TOOL_MODE = "codex" as const;
export const WORKBRIDGE_WIDGET_MODE = "off" as const;
export const WORKBRIDGE_REVIEW_TOOL_NAME = "show_changes" as const;
export const WORKBRIDGE_EXTENSION_TOOL_NAMES = [
  "run_workspace_action",
  "check_ao_credential_status",
  "run_semantic_action",
  "run_graft_action",
] as const;
export const WORKBRIDGE_SUBAGENTS_ENABLED = false as const;

export const WORKBRIDGE_DISABLED_CAPABILITIES = [
  "runtime-profile-switching",
  "subagents",
] as const;
