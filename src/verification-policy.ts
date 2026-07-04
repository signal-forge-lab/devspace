import type { DevspaceTaskClass } from "./devspace-efficiency-classifier.js";
import type { DevspaceVerifyProfile } from "./devspace-verify.js";

export interface VerificationPolicyInput {
  taskClass: DevspaceTaskClass;
  paths?: string[];
  intent?: string;
}

export interface VerificationPolicyPlan extends Record<string, unknown> {
  taskClass: DevspaceTaskClass;
  profiles: DevspaceVerifyProfile[];
  reasons: string[];
  note: string;
}

export function planVerificationPolicy(input: VerificationPolicyInput): VerificationPolicyPlan {
  const profiles: DevspaceVerifyProfile[] = [];
  const reasons: string[] = [];
  const add = (profile: DevspaceVerifyProfile, reason: string) => {
    if (!profiles.includes(profile)) profiles.push(profile);
    if (!reasons.includes(reason)) reasons.push(reason);
  };
  const paths = input.paths ?? [];
  const text = `${input.intent ?? ""} ${paths.join(" ")}`.toLowerCase();
  const hasTypeScript = paths.some((path) => /(^src\/|\.ts$|\.tsx$)/.test(path));
  const hasWorkflowTools = paths.some((path) => /src\/(workflow-tools|workflow-tools-registration|operation-router|devspace-verify|verification-policy|incident-classifier|alternate-path-detector)\.ts$/.test(path));
  const hasSafeEditing = paths.some((path) => /src\/(safe-editing|structured-inspection|edit-many)/.test(path));
  const hasPackageOrBuild = paths.some((path) => /(^package(-lock)?\.json$|^tsconfig|^vite\.config|^scripts\/|^src\/.*\.test\.ts$)/.test(path));
  const asksBuild = /build|bundle|dist|vite|package/.test(text);
  const asksTest = /test|verify|validation|smoke|router|workflow|policy|incident|alternate/.test(text);

  add("git_status_check", "always_check_workspace_state");
  if (input.taskClass !== "read_inspect") add("git_diff_check", "check_working_tree_diff_for_changes");

  if (input.taskClass === "read_inspect") {
    return finish(input.taskClass, profiles, reasons);
  }

  if (input.taskClass === "validation_test") {
    if (/workflow/.test(text)) add("workflow_tools_test", "requested_workflow_validation");
    else if (/safe/.test(text)) add("safe_editing_test", "requested_safe_editing_validation");
    else if (/build/.test(text)) add("build", "requested_build_validation");
    else if (/npm test|full test/.test(text)) add("npm_test", "requested_full_test_validation");
    return finish(input.taskClass, profiles, reasons);
  }

  if (hasTypeScript || hasPackageOrBuild || ["large_edit_refactor", "structured_sensitive_integration", "packaging_release", "incident_recovery"].includes(input.taskClass)) {
    add("typecheck_only", "typescript_or_shared_workflow_change");
  }
  if (hasWorkflowTools || /workflow|router|verify|policy|incident|alternate/.test(text)) add("workflow_tools_test", "workflow_tooling_change");
  if (hasSafeEditing) add("safe_editing_test", "safe_editing_related_change");
  if (input.taskClass === "large_edit_refactor") add("related_tests", "large_refactor_needs_related_tests");
  if (input.taskClass === "structured_sensitive_integration") add("workflow_tools_test", "mock_first_sensitive_workflow_check");
  if (input.taskClass === "packaging_release") add("npm_test", "package_release_metadata_check");
  if (input.taskClass === "packaging_release" || asksBuild || hasPackageOrBuild) add("build", "build_or_package_related_change");
  if (asksTest && input.taskClass !== "small_edit") add("npm_test", "explicit_test_or_validation_intent");

  return finish(input.taskClass, profiles, reasons);
}

function finish(taskClass: DevspaceTaskClass, profiles: DevspaceVerifyProfile[], reasons: string[]): VerificationPolicyPlan {
  return {
    taskClass,
    profiles,
    reasons,
    note: "Verification policy suggests fixed devspace_verify profiles only; it does not include live external smoke by default.",
  };
}
