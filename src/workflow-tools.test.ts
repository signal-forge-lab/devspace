import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import assert from "node:assert/strict";
import type { Workspace } from "./workspaces.js";
import { applyStructuredEdit, applyUnifiedPatch, checkWorkspaceInvariants, decodeStructuredContent, devspaceRouter, recordWorkflowEvent, resolveLocator } from "./workflow-tools.js";

const execFileAsync = promisify(execFile);
const root = await mkdtemp(join(tmpdir(), "devspace-workflow-tools-"));
try {
  await execFileAsync("git", ["init"], { cwd: root });
  await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: root });
  await execFileAsync("git", ["config", "user.name", "Test User"], { cwd: root });
  await writeFile(join(root, "README.md"), "# Title\n\n## Target\nold line\nkeep\n\n## Next\nend\n", "utf8");
  await writeFile(join(root, "package.json"), JSON.stringify({ version: "1.0.0" }, null, 2) + "\n", "utf8");
  await writeFile(join(root, "package-lock.json"), JSON.stringify({ packages: { "": { version: "1.0.0" } } }, null, 2) + "\n", "utf8");
  await execFileAsync("git", ["add", "README.md", "package.json", "package-lock.json"], { cwd: root });
  await execFileAsync("git", ["commit", "-m", "init"], { cwd: root });

  const workspace: Workspace = { id: "ws_workflow_test", root, mode: "checkout", skills: [], skillDiagnostics: [], activatedSkillDirs: new Set() };
  const readme = await readFile(join(root, "README.md"), "utf8");
  const readmeSha = sha256(readme);
  const patch = [
    "diff --git a/README.md b/README.md",
    "--- a/README.md",
    "+++ b/README.md",
    "@@ -1,8 +1,8 @@",
    " # Title",
    " ",
    " ## Target",
    "-old line",
    "+new line",
    " keep",
    " ",
    " ## Next",
    " end",
    "",
  ].join("\n");

  const dryPatch = await applyUnifiedPatch({ workspace, patch, expectedBase: [{ path: "README.md", sha256: readmeSha }], dryRun: true, workflowMode: "zip_first" });
  assert.equal(dryPatch.status, "validated");
  assert.equal(dryPatch.contentEncoding, "plain");
  assert.equal(dryPatch.summary.additions, 1);
  assert.equal(dryPatch.summary.removals, 1);
  assert.equal(await readFile(join(root, "README.md"), "utf8"), readme);

  const appliedPatch = await applyUnifiedPatch({ workspace, patch, expectedBase: [{ path: "README.md", sha256: readmeSha }], dryRun: false });
  assert.equal(appliedPatch.status, "applied");
  assert.match(await readFile(join(root, "README.md"), "utf8"), /new line/);
  await assert.rejects(
    () => applyUnifiedPatch({ workspace, patch, expectedBase: [{ path: "README.md", sha256: readmeSha }], dryRun: true }),
    /sha256 mismatch/,
  );

  const afterPatch = await readFile(join(root, "README.md"), "utf8");
  const section = await resolveLocator({ workspace, path: "README.md", locator: { type: "section_heading", heading: "## Target" } });
  assert.equal(section.matchCount, 1);
  assert.ok(section.selected);
  assert.match(section.selected.preview, /new line/);

  const editDry = await applyStructuredEdit({
    workspace,
    path: "README.md",
    expectedSha256: sha256(afterPatch),
    locator: { type: "section_heading", heading: "## Target" },
    operation: { type: "replace_section_body", content: "structured line\nkeep\n\n" },
    dryRun: true,
    workflowMode: "router",
  });
  assert.equal(editDry.status, "validated");
  assert.equal(editDry.contentEncoding, "plain");
  assert.match(await readFile(join(root, "README.md"), "utf8"), /new line/);
  await applyStructuredEdit({
    workspace,
    path: "README.md",
    expectedSha256: sha256(afterPatch),
    locator: { type: "section_heading", heading: "## Target" },
    operation: { type: "replace_section_body", content: "structured line\nkeep\n\n" },
    dryRun: false,
  });
  assert.match(await readFile(join(root, "README.md"), "utf8"), /structured line/);

  const afterStructuredEdit = await readFile(join(root, "README.md"), "utf8");
  const base64Content = Buffer.from("template literal: `${value}`\nkeep\n\n", "utf8").toString("base64");
  const base64DryRun = await applyStructuredEdit({
    workspace,
    path: "README.md",
    expectedSha256: sha256(afterStructuredEdit),
    locator: { type: "section_heading", heading: "## Target" },
    operation: { type: "replace_section_body", content: base64Content, contentEncoding: "base64", maxDecodedBytes: 100 },
    dryRun: true,
  });
  assert.equal(base64DryRun.status, "validated");
  assert.equal(base64DryRun.contentEncoding, "base64");
  assert.equal(await readFile(join(root, "README.md"), "utf8"), afterStructuredEdit);
  await applyStructuredEdit({
    workspace,
    path: "README.md",
    expectedSha256: sha256(afterStructuredEdit),
    locator: { type: "section_heading", heading: "## Target" },
    operation: { type: "replace_section_body", content: base64Content, contentEncoding: "base64", maxDecodedBytes: 100 },
    dryRun: false,
  });
  assert.match(await readFile(join(root, "README.md"), "utf8"), /\$\{value\}/);
  assert.throws(() => decodeStructuredContent({ content: "not base64", contentEncoding: "base64" }), /not valid base64/);
  assert.throws(() => decodeStructuredContent({ content: base64Content, contentEncoding: "base64", maxDecodedBytes: 5 }), /decoded size exceeds/);

  const afterBase64Edit = await readFile(join(root, "README.md"), "utf8");
  const base64PatchText = [
    "diff --git a/README.md b/README.md",
    "--- a/README.md",
    "+++ b/README.md",
    "@@ -3,6 +3,6 @@",
    " ## Target",
    "-template literal: `${value}`",
    "+patched via base64",
    " keep",
    " ",
    " ## Next",
    " end",
    "",
  ].join("\n");
  const base64Patch = Buffer.from(base64PatchText, "utf8").toString("base64");
  const patchDryRun = await applyUnifiedPatch({
    workspace,
    patch: base64Patch,
    contentEncoding: "base64",
    expectedBase: [{ path: "README.md", sha256: sha256(afterBase64Edit) }],
    dryRun: true,
  });
  assert.equal(patchDryRun.status, "validated");
  assert.equal(patchDryRun.contentEncoding, "base64");

  const invariants = await checkWorkspaceInvariants({
    workspace,
    checks: [
      { type: "token_absent", token: "old line", paths: ["README.md"] },
      { type: "token_present", token: "template literal", paths: ["README.md"], minCount: 1 },
      { type: "structured_value_equal", values: [{ path: "package.json", pointer: "/version" }, { path: "package-lock.json", pointer: "/packages//version" }] },
    ],
  });
  assert.equal(invariants.status, "ok");

  const failed = await checkWorkspaceInvariants({ workspace, checks: [{ type: "token_absent", token: "template literal", paths: ["README.md"] }] });
  assert.equal(failed.status, "failed");


  const routerStart = await devspaceRouter({ workspace, workflowMode: "router", action: "start", intent: "unit test router" });
  assert.equal(routerStart.status, "ok");
  assert.equal(routerStart.nextRecommendedAction, "snapshot");
  assert.ok(routerStart.refs.jobId);
  assert.ok(routerStart.runtimeInfo.appVersion.length > 0);
  assert.ok(routerStart.runtimeInfo.processStartedAt.length > 0);
  const startGuidance = routerStart.results.routeGuidance as { patchTools: Array<{ tool: string }>; processTools: Array<{ tool: string }> };
  assert.ok(startGuidance.patchTools.some((item) => item.tool === "apply_patch"));
  assert.ok(startGuidance.patchTools.some((item) => item.tool === "apply_unified_patch"));
  assert.ok(startGuidance.processTools.some((item) => item.tool === "exec_command/write_stdin"));

  const routerSnapshot = await devspaceRouter({ workspace, workflowMode: "router", action: "snapshot", refs: routerStart.refs, limits: { maxFiles: 5 } });
  assert.equal(routerSnapshot.status, "ok");
  assert.equal(routerSnapshot.nextRecommendedAction, "inspect");

  const routerInspect = await devspaceRouter({ workspace, workflowMode: "router", action: "inspect", targets: { paths: ["README.md"] }, limits: { maxFiles: 1, maxLines: 5, maxOutputChars: 500 } });
  assert.equal(routerInspect.status, "ok");
  assert.equal((routerInspect.results.files as Array<{ path: string }>)[0].path, "README.md");

  const routerLocator = await devspaceRouter({ workspace, workflowMode: "router", action: "resolve_locator", locatorRequest: { path: "README.md", locator: { type: "section_heading", heading: "## Target" } } });
  assert.equal(routerLocator.status, "ok");
  assert.equal(routerLocator.nextRecommendedAction, "apply_structured_edit_dry_run");

  const routerInvariant = await devspaceRouter({ workspace, workflowMode: "router", action: "check_invariants", invariantChecks: [{ type: "token_present", token: "template literal", paths: ["README.md"] }] });
  assert.equal(routerInvariant.status, "ok");
  assert.equal(routerInvariant.nextRecommendedAction, "verify_or_summarize");

  const routerVerifyPlan = await devspaceRouter({ workspace, workflowMode: "router", action: "verify_plan", intent: "workflow router test build", targets: { paths: ["src/workflow-tools.ts", "package.json"] } });
  assert.equal(routerVerifyPlan.status, "ok");
  assert.equal(routerVerifyPlan.nextRecommendedAction, "devspace_verify:git_status_check");
  assert.ok(routerVerifyPlan.runtimeInfo.gitCommit.length > 0);
  const verifyRouteGuidance = routerVerifyPlan.results.routeGuidance as { patchTools: Array<{ tool: string }> };
  assert.ok(verifyRouteGuidance.patchTools.some((item) => item.tool === "apply_patch"));
  const verifyPlan = routerVerifyPlan.results.verifyPlan as { profiles: string[]; reasons: string[]; commandSequence: Array<{ tool: string; profile: string }>; taskClass: string };
  assert.equal(verifyPlan.taskClass, "packaging_release");
  assert.ok(verifyPlan.profiles.includes("git_status_check"));
  assert.ok(verifyPlan.profiles.includes("git_diff_check"));
  assert.ok(verifyPlan.profiles.includes("typecheck_only"));
  assert.ok(verifyPlan.profiles.includes("workflow_tools_test"));
  assert.ok(verifyPlan.profiles.includes("npm_test"));
  assert.ok(verifyPlan.profiles.includes("build"));
  assert.deepEqual(verifyPlan.commandSequence[0], { tool: "devspace_verify", profile: "git_status_check" });

  const routerSuggestVerify = await devspaceRouter({ workspace, workflowMode: "router", action: "suggest_verify", targets: { paths: ["README.md"] } });
  const suggestedPlan = routerSuggestVerify.results.verifyPlan as { profiles: string[] };
  assert.deepEqual(suggestedPlan.profiles, ["git_status_check", "git_diff_check"]);

  const largeRefactorPlanResult = await devspaceRouter({ workspace, workflowMode: "router", action: "verify_plan", taskClass: "large_edit_refactor", targets: { paths: ["src/popup.tsx", "scripts/run.ps1"] } });
  const largeRefactorPlan = largeRefactorPlanResult.results.verifyPlan as { taskClass: string; alternatePaths: Array<{ path: string; categories: string[] }>; profiles: string[] };
  assert.equal(largeRefactorPlan.taskClass, "large_edit_refactor");
  assert.ok(largeRefactorPlan.alternatePaths.some((item) => item.categories.includes("popup_or_ui_entry")));
  assert.ok(largeRefactorPlan.alternatePaths.some((item) => item.categories.includes("batch_or_script_entry")));
  assert.ok(largeRefactorPlan.profiles.includes("related_tests"));

  const inferredLargeRefactorPlanResult = await devspaceRouter({
    workspace,
    workflowMode: "router",
    action: "verify_plan",
    intent: "split large UI module and update fallback entry paths",
    targets: { paths: ["src/popup.tsx", "src/runtime.ts"] },
  });
  const inferredLargeRefactorPlan = inferredLargeRefactorPlanResult.results.verifyPlan as { taskClass: string; alternatePaths: Array<{ path: string; categories: string[] }>; profiles: string[] };
  assert.equal(inferredLargeRefactorPlan.taskClass, "large_edit_refactor");
  assert.ok(inferredLargeRefactorPlan.alternatePaths.some((item) => item.categories.includes("popup_or_ui_entry")));
  assert.ok(inferredLargeRefactorPlan.alternatePaths.some((item) => item.categories.includes("daemon_or_runtime_entry")));
  assert.ok(inferredLargeRefactorPlan.profiles.includes("related_tests"));

  const event = await recordWorkflowEvent({ workspace, workflowMode: "zip_first_router", event: "unit_test", action: "verify", filesChanged: 1 });
  assert.equal(event.recorded, true);
  assert.equal(existsSync(event.path), true);
} finally {
  await rm(root, { recursive: true, force: true });
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
