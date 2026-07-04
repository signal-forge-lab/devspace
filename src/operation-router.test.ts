import assert from "node:assert/strict";
import { detectAlternateExecutionPath } from "./alternate-path-detector.js";
import { classifyWorkbridgeEfficiency } from "./workbridge-efficiency-classifier.js";
import { classifyIncident } from "./incident-classifier.js";
import { routeSafeOperation } from "./operation-router.js";
import { prepareSensitiveIntegrationWorkflow, validateEnvVarName } from "./sensitive-integration.js";
import { planVerificationPolicy } from "./verification-policy.js";

const routedGit = routeSafeOperation({ operation: "commit", commandShape: "git add . && git commit", usesGit: true });
assert.equal(routedGit.recommendedTool, "git_commit_files");
assert.equal(routedGit.risk, "medium");

const routedEdit = routeSafeOperation({ plannedTool: "bash", operation: "edit html", writesFiles: true, editCharacters: 9000 });
assert.equal(routedEdit.risk, "high");
assert.match(routedEdit.recommendedTool, /edit_by_line_range/);

const routedFunction = routeSafeOperation({
  plannedTool: "edit_by_line_range",
  operation: "replace whole function",
  writesFiles: true,
  targetKind: "function",
  symbol: "toolNamesFor",
});
assert.equal(routedFunction.recommendedTool, "replace_symbol");
assert.equal(routedFunction.strategy, "replace_named_symbol");
assert.equal(routedFunction.risk, "medium");
assert.match(routedFunction.result, /Target symbol: toolNamesFor/);

const routedKnownSmallRead = routeSafeOperation({
  plannedTool: "read_many",
  operation: "inspect known files small ranges",
  fileCount: 5,
});
assert.equal(routedKnownSmallRead.recommendedTool, "read_index_ranges");
assert.equal(routedKnownSmallRead.strategy, "small_known_ranges_indexed_read");

const routedReadHeavy = routeSafeOperation({
  plannedTool: "read_many",
  operation: "inspect large extension script residue checks",
  fileCount: 4,
});
assert.equal(routedReadHeavy.recommendedTool, "export_workspace_zip + create_zip_download_url");
assert.equal(routedReadHeavy.strategy, "zip_first_read_then_mcp_writes");
assert.equal(routedReadHeavy.risk, "medium");

const routedHeredoc = routeSafeOperation({ plannedTool: "bash", commandShape: "python - <<'PY'" });
assert.equal(routedHeredoc.risk, "high");
assert.ok(routedHeredoc.reasons.includes("shell_heredoc_shape"));

const sensitiveClassification = classifyWorkbridgeEfficiency({
  intent: "add API key config using env var AEGIS_GATE_LLM_API_KEY and mock-first tests",
  envVarReferences: ["AEGIS_GATE_LLM_API_KEY"],
  secretValueHandling: "never_read_or_write",
});
assert.equal(sensitiveClassification.taskClass, "structured_sensitive_integration");
assert.equal(sensitiveClassification.risk, "medium");
assert.equal(sensitiveClassification.efficiencyGoal, "separate_secret_reference_from_secret_value_and_generate_config_mock_first");
assert.ok(sensitiveClassification.recommendedSequence.includes("validate_env_var_reference"));
assert.ok(sensitiveClassification.requiredChecks.includes("no_secret_value_input"));
assert.equal(sensitiveClassification.transportRecommendation, "plain_structured_edit");
assert.equal(sensitiveClassification.blockedPattern, "live_secret_value_or_live_api_call_in_first_step");

const naturalLargeRefactor = classifyWorkbridgeEfficiency({
  intent: "split large UI module and update fallback entry paths",
});
assert.equal(naturalLargeRefactor.taskClass, "large_edit_refactor");
assert.equal(naturalLargeRefactor.risk, "high");
assert.equal(naturalLargeRefactor.transportRecommendation, "unified_patch_with_hash_guard");
assert.ok(naturalLargeRefactor.requiredChecks.includes("alternate_execution_path_inventory"));

const routeNaturalLargeRefactor = routeSafeOperation({
  operation: "split large UI module and update fallback entry paths",
});
assert.equal(routeNaturalLargeRefactor.taskClass, "large_edit_refactor");
assert.equal(routeNaturalLargeRefactor.risk, "high");
assert.ok(routeNaturalLargeRefactor.requiredChecks.includes("alternate_execution_path_inventory"));

const routeSensitive = routeSafeOperation({
  operation: "update config for TOKEN_ENV_VAR reference only",
  writesFiles: true,
  editCharacters: 500,
  envVarReferences: ["TOKEN_ENV_VAR"],
  secretValueHandling: "never_read_or_write",
});
assert.equal(routeSensitive.taskClass, "structured_sensitive_integration");
assert.equal(routeSensitive.efficiencyGoal, sensitiveClassification.efficiencyGoal);

assert.equal(validateEnvVarName("DEVSPACE_API_KEY"), "DEVSPACE_API_KEY");
assert.throws(() => validateEnvVarName("devspace_api_key"), /env var name/);
assert.throws(() => validateEnvVarName("DEVSPACE_API_KEY=real-value"), /env var name/);

const sensitivePlan = prepareSensitiveIntegrationWorkflow({
  envVarName: "DEVSPACE_API_KEY",
  configKey: "apiKeyEnvVar",
  secretValueHandling: "never_read_or_write",
  mode: "config_and_mock_only",
});
assert.equal(sensitivePlan.envVar.name, "DEVSPACE_API_KEY");
assert.equal(sensitivePlan.envVar.configKey, "apiKeyEnvVar");
assert.equal(sensitivePlan.liveSmokeAllowed, false);
assert.ok(sensitivePlan.recommendedSequence.includes("write_mock_first_test"));
assert.doesNotMatch(JSON.stringify(sensitivePlan), /real-value/);

assert.throws(
  () => prepareSensitiveIntegrationWorkflow({
    envVarName: "DEVSPACE_API_KEY",
    secretValueHandling: "never_read_or_write",
    secretValue: "real-value",
  }),
  /real secret value field is not accepted/,
);

assert.throws(
  () => prepareSensitiveIntegrationWorkflow({
    envVar: { kind: "env_var", name: "DEVSPACE_API_KEY", token: "real-value" } as never,
    secretValueHandling: "never_read_or_write",
  }),
  /real secret value field is not accepted/,
);
assert.throws(
  () => prepareSensitiveIntegrationWorkflow({
    envVarName: "DEVSPACE_API_KEY",
    secretValueHandling: "bad" as never,
  }),
  /secretValueHandling/,
);

const popupPath = detectAlternateExecutionPath({ path: "src/popup.tsx", content: "manual bootstrap fallback" });
assert.deepEqual(popupPath.categories, ["fallback_entry", "manual_injection", "popup_or_ui_entry"]);
assert.match(popupPath.reviewHint, /fallback/);

const largePolicy = planVerificationPolicy({ taskClass: "large_edit_refactor", paths: ["src/workflow-tools.ts"], intent: "workflow refactor" });
assert.ok(largePolicy.profiles.includes("git_status_check"));
assert.ok(largePolicy.profiles.includes("git_diff_check"));
assert.ok(largePolicy.profiles.includes("typecheck_only"));
assert.ok(largePolicy.profiles.includes("related_tests"));
assert.ok(largePolicy.profiles.includes("workflow_tools_test"));

const readPolicy = planVerificationPolicy({ taskClass: "read_inspect", paths: ["README.md"] });
assert.deepEqual(readPolicy.profiles, ["git_status_check"]);

const incident = classifyIncident({ error: "OpenAI host safety blocked heredoc edit" });
assert.equal(incident.category, "heredoc_or_quoting_syntax");
assert.equal(incident.improvementAction, "use_structured_edit_transport");

const schemaIncident = classifyIncident({ error: "MCP output validation invalid_type" });
assert.equal(schemaIncident.category, "schema_validation");
assert.equal(schemaIncident.improvementAction, "switch_to_structured_schema");

const routedCodexPatch = routeSafeOperation({
  toolMode: "codex",
  operation: "apply Codex patch with *** Begin Patch markers",
  writesFiles: true,
});
assert.equal(routedCodexPatch.recommendedTool, "apply_patch");
assert.equal(routedCodexPatch.strategy, "codex_patch_format_add_update_delete_move");
assert.ok(routedCodexPatch.reasons.includes("codex_patch_requested"));

const routedGuardedPatch = routeSafeOperation({
  operation: "apply hash-guarded unified diff with expectedBase sha256",
  writesFiles: true,
});
assert.equal(routedGuardedPatch.recommendedTool, "apply_unified_patch");
assert.equal(routedGuardedPatch.strategy, "hash_guarded_unified_diff");
assert.ok(routedGuardedPatch.reasons.includes("hash_guarded_patch_requested"));

const routedProcessSession = routeSafeOperation({
  toolMode: "codex",
  operation: "run long-running interactive server and poll session",
  commandShape: "npm run dev",
});
assert.equal(routedProcessSession.recommendedTool, "exec_command + write_stdin");
assert.equal(routedProcessSession.strategy, "use_resumable_process_session");
assert.ok(routedProcessSession.reasons.includes("process_session_requested"));

const routedCodexValidation = routeSafeOperation({
  toolMode: "codex",
  operation: "run typecheck validation",
  commandShape: "npm run typecheck",
});
assert.equal(routedCodexValidation.recommendedTool, "exec_command");
assert.equal(routedCodexValidation.strategy, "run_validation_as_process_session");
