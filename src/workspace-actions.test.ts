import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  WorkspaceActionResolutionError,
  resolveWorkspaceAction,
  workspaceActionCatalog,
} from "./workspace-actions.js";
import { launchDetachedWorkspaceAction } from "./detached-workspace-action.js";
import { processStep, workspaceActionSteps } from "./workspace-action-plans.js";

const aoTemporaryRoot = await mkdtemp(join(tmpdir(), "workbridge-ao-action-test-"));
const aoWorkspaceRoot = join(aoTemporaryRoot, "TradingAgents");
const aoInputsRoot = join(aoTemporaryRoot, "inputs");
await mkdir(join(aoWorkspaceRoot, "tradingagents"), { recursive: true });
await mkdir(aoInputsRoot, { recursive: true });
await writeFile(
  join(aoWorkspaceRoot, "tradingagents", "ao_d60_registered_run.py"),
  "print('AO action test fixture')\n",
);
await writeFile(
  join(aoWorkspaceRoot, "tradingagents", "ao_registered_market_freeze.py"),
  "print('AO freeze test fixture')\n",
);
await writeFile(
  join(aoWorkspaceRoot, "tradingagents", "ao_freeze_first_run.py"),
  "print('AO freeze-first run fixture')\n",
);
const aoInputPaths = {
  bindingPath: join(aoInputsRoot, "binding.json"),
  registrationPath: join(aoInputsRoot, "registration.json"),
  d60TaskPath: join(aoInputsRoot, "d60.md"),
  d61TaskPath: join(aoInputsRoot, "d61.md"),
  d62TaskPath: join(aoInputsRoot, "d62.md"),
  d63TaskPath: join(aoInputsRoot, "d63.md"),
  pricingSnapshotPath: join(aoInputsRoot, "pricing.json"),
};
for (const path of Object.values(aoInputPaths)) {
  await writeFile(path, "fixture\n");
}
const aoExecuteParameters = {
  windowOpenUtc: "2026-09-01T20:15:00Z",
  windowCloseUtc: "2026-09-02T12:00:00Z",
  ...aoInputPaths,
  outputPath: join(aoWorkspaceRoot, "local_runs", "future-registration", "d60"),
};
const aegisWorkspaceRoot = await mkdtemp(join(tmpdir(), "workbridge-aegis-action-test-"));
await writeFile(join(aegisWorkspaceRoot, "aegis_runner.py"), "print('Aegis fixture')\n");

const catalog = workspaceActionCatalog();
assert.deepEqual(catalog.map((entry) => entry.action), [
  "workspace_verify",
  "workspace_review",
  "project_verify",
  "test_changed",
  "project_report",
  "ao_registered_python",
  "publish_artifact",
  "aegis_runner",
]);
assert.equal(catalog[0]?.defaultPreset, "standard");
assert.deepEqual(catalog[0]?.policy, ["workspace_modify", "long_running"]);
assert.equal(catalog[1]?.defaultPreset, "summary");
assert.deepEqual(catalog[1]?.policy, ["read_only"]);
assert.deepEqual(catalog[1]?.presets.map((preset) => preset.name), ["summary", "integrity"]);
assert.deepEqual(catalog[2]?.presets.map((preset) => preset.name), ["quick", "standard"]);
assert.deepEqual(catalog[3]?.presets.map((preset) => preset.name), ["exact"]);
assert.deepEqual(catalog[4]?.presets.map((preset) => preset.name), ["profile"]);
assert.deepEqual(catalog[5]?.presets.map((preset) => preset.name), ["help", "execute", "freeze_first_execute"]);
assert.deepEqual(catalog[5]?.policy, ["workspace_modify", "external_effect", "long_running"]);
assert.deepEqual(catalog[6]?.presets.map((preset) => preset.name), ["embedded_zip"]);
assert.deepEqual(catalog[6]?.policy, ["read_only", "external_effect"]);
assert.deepEqual(catalog[7]?.presets.map((preset) => preset.name), ["run_confirm_post"]);
assert.deepEqual(catalog[7]?.policy, ["workspace_modify", "external_effect", "long_running"]);

const aegisRunner = await resolveWorkspaceAction({
  workspaceRoot: aegisWorkspaceRoot,
  action: "aegis_runner",
});
assert.equal(aegisRunner.preset, "run_confirm_post");
assert.match(aegisRunner.command, /aegis_runner\.py run --confirm-post/);
assert.deepEqual(aegisRunner.parameters, {});
assert.equal(aegisRunner.plan?.steps.length, 1);

await assert.rejects(
  () => resolveWorkspaceAction({
    workspaceRoot: process.cwd(),
    action: "aegis_runner",
  }),
  (error: unknown) => {
    assert.ok(error instanceof WorkspaceActionResolutionError);
    assert.equal(error.kind, "unsupported_action_for_profile");
    assert.match(error.message, /aegis_runner\.py/);
    return true;
  },
);

const detachedRoot = await mkdtemp(join(tmpdir(), "workbridge-detached-action-test-"));
const detachedScript = join(detachedRoot, "child.mjs");
const detachedMarker = join(detachedRoot, "marker.txt");
await writeFile(
  detachedScript,
  `import { writeFileSync } from "node:fs";\nsetTimeout(() => writeFileSync(process.argv[2], "ok"), 150);\n`,
  "utf8",
);
const detached = await launchDetachedWorkspaceAction({
  workspaceId: "workspace-detached-test",
  workspaceRoot: detachedRoot,
  cwd: detachedRoot,
  plan: workspaceActionSteps([
    processStep("launch", "Launch detached fixture", process.execPath, [detachedScript, detachedMarker]),
  ]),
});
assert.ok(detached.pid && detached.pid > 0);
await new Promise((resolve) => setTimeout(resolve, 500));
await access(detachedMarker);
await rm(detachedRoot, { recursive: true, force: true });

for (const retiredAction of ["encoded_input_probe", "progress_probe"]) {
  await assert.rejects(
    () => resolveWorkspaceAction({
      workspaceRoot: process.cwd(),
      action: retiredAction,
    }),
    (error: unknown) => {
      assert.ok(error instanceof WorkspaceActionResolutionError);
      assert.equal(error.kind, "unsupported_action");
      assert.equal(error.requestedAction, retiredAction);
      return true;
    },
  );
}

const resolved = await resolveWorkspaceAction({
  workspaceRoot: process.cwd(),
  action: "workspace_verify",
});
assert.equal(resolved.action, "workspace_verify");
assert.equal(resolved.preset, "standard");
assert.equal(resolved.profile, "workbridge");
assert.equal(resolved.command, "npm run verify:rebase && git status --short");
assert.deepEqual(resolved.parameters, {});

const reviewSummary = await resolveWorkspaceAction({
  workspaceRoot: process.cwd(),
  action: "workspace_review",
});
assert.equal(reviewSummary.preset, "summary");
assert.deepEqual(reviewSummary.policy, ["read_only"]);
assert.match(reviewSummary.command, /git status --short/);
assert.match(reviewSummary.command, /git diff --stat/);
assert.match(reviewSummary.command, /git diff --cached --stat/);

const reviewIntegrity = await resolveWorkspaceAction({
  workspaceRoot: process.cwd(),
  action: "workspace_review",
  preset: "integrity",
});
assert.equal(reviewIntegrity.preset, "integrity");
assert.deepEqual(reviewIntegrity.policy, ["read_only"]);
assert.match(reviewIntegrity.command, /git diff --check/);

const projectVerify = await resolveWorkspaceAction({
  workspaceRoot: process.cwd(),
  action: "project_verify",
});
assert.equal(projectVerify.profile, "workbridge");
assert.equal(projectVerify.preset, "standard");
assert.equal(projectVerify.command, "npm run verify:rebase && git status --short");
assert.deepEqual(projectVerify.policy, ["workspace_modify", "long_running"]);
assert.ok(projectVerify.profileEvidence.length > 0);
assert.deepEqual(projectVerify.warnings, []);
assert.deepEqual(projectVerify.artifacts, []);
assert.equal(resolved.command, projectVerify.command);
assert.deepEqual(resolved.plan, projectVerify.plan);

const projectVerifyQuick = await resolveWorkspaceAction({
  workspaceRoot: process.cwd(),
  action: "project_verify",
  preset: "quick",
});
assert.equal(projectVerifyQuick.profile, "workbridge");
assert.equal(projectVerifyQuick.preset, "quick");
assert.match(projectVerifyQuick.command, /npm run typecheck/);
assert.match(projectVerifyQuick.command, /npm run baseline:tools:check/);
assert.doesNotMatch(projectVerifyQuick.command, /npm test/);
assert.doesNotMatch(projectVerifyQuick.command, /npm run build/);

assert.ok(resolved.warnings.some((warning) => /compatibility alias/.test(warning)));
assert.ok(resolved.profileEvidence.length > 0);

const projectVerifyNode = await resolveWorkspaceAction({
  workspaceRoot: process.cwd(),
  action: "project_verify",
  parameters: { profile: "node" },
});
assert.equal(projectVerifyNode.profile, "node");
assert.match(projectVerifyNode.command, /npm run typecheck/);

const projectReport = await resolveWorkspaceAction({
  workspaceRoot: process.cwd(),
  action: "project_report",
});
assert.equal(projectReport.profile, "workbridge");
assert.equal(projectReport.preset, "profile");
assert.deepEqual(projectReport.policy, ["workspace_modify"]);
assert.equal(projectReport.artifacts.length, 1);
assert.match(projectReport.artifacts[0]?.path ?? "", /^\.workbridge\/reports\/project-profile-/);
assert.match(projectReport.command, /^write-json /);

const aoHelp = await resolveWorkspaceAction({
  workspaceRoot: aoWorkspaceRoot,
  action: "ao_registered_python",
  allowedRoots: [aoTemporaryRoot],
});
assert.equal(aoHelp.action, "ao_registered_python");
assert.equal(aoHelp.preset, "help");
assert.equal(aoHelp.profile, "python");
assert.deepEqual(aoHelp.parameters, {});
assert.deepEqual(aoHelp.policy, ["read_only"]);
assert.match(aoHelp.command, /tradingagents\.ao_d60_registered_run --help/);
assert.doesNotMatch(aoHelp.command, /execute-registered/);
assert.ok(aoHelp.profileEvidence.some((entry) => /scientific input parameters: none/.test(entry)));

const aoExecute = await resolveWorkspaceAction({
  workspaceRoot: aoWorkspaceRoot,
  action: "ao_registered_python",
  preset: "execute",
  parameters: aoExecuteParameters,
  allowedRoots: [aoTemporaryRoot],
});
const aoExecuteAgain = await resolveWorkspaceAction({
  workspaceRoot: aoWorkspaceRoot,
  action: "ao_registered_python",
  preset: "execute",
  parameters: aoExecuteParameters,
  allowedRoots: [aoTemporaryRoot],
});
assert.equal(aoExecute.profile, "python");
assert.deepEqual(aoExecute.policy, ["workspace_modify", "external_effect", "long_running"]);
assert.match(aoExecute.command, /--window-open-utc 2026-09-01T20:15:00Z/);
assert.match(aoExecute.command, /--window-close-utc 2026-09-02T12:00:00Z/);
assert.match(aoExecute.command, /--execute-registered/);
assert.doesNotMatch(aoExecute.displayCommand, new RegExp(escapeRegex(aoTemporaryRoot), "i"));
assert.match(aoExecute.displayCommand, /<bindingPath>/);
assert.equal(aoExecute.parameters.bindingPath, "<bindingPath>");
assert.ok(aoExecute.outputRedactions?.some((entry) => entry.replacement === "<bindingPath>"));
assert.equal(aoExecute.artifacts[0]?.path, "local_runs/future-registration/d60");
assert.equal(aoExecute.command, aoExecuteAgain.command);
assert.deepEqual(aoExecute.plan, aoExecuteAgain.plan);
assert.deepEqual(aoExecute.parameters, aoExecuteAgain.parameters);

const freezeBindingPath = join(aoInputsRoot, "freeze-first-binding.json");
const freezeBindingBytes = Buffer.from('{"schema_version":"fixture"}\n', "utf8");
await writeFile(freezeBindingPath, freezeBindingBytes);
const freezeBindingSha256 = createHash("sha256").update(freezeBindingBytes).digest("hex");
const freezeFirstParameters = {
  bindingPath: freezeBindingPath,
  bindingSha256: freezeBindingSha256,
  freezeOutputPath: join(aoWorkspaceRoot, "local_runs", "future-registration", "market_freeze"),
  decisionOutputPath: join(aoWorkspaceRoot, "local_runs", "future-registration", "decision"),
  cryptoRootPath: aoInputsRoot,
};
const freezeFirst = await resolveWorkspaceAction({
  workspaceRoot: aoWorkspaceRoot,
  action: "ao_registered_python",
  preset: "freeze_first_execute",
  parameters: freezeFirstParameters,
  allowedRoots: [aoTemporaryRoot],
});
assert.equal(freezeFirst.preset, "freeze_first_execute");
assert.equal(freezeFirst.plan?.steps.length, 2);
assert.match(freezeFirst.command, /tradingagents\.ao_registered_market_freeze/);
assert.match(freezeFirst.command, /tradingagents\.ao_freeze_first_run/);
assert.deepEqual(freezeFirst.policy, ["workspace_modify", "external_effect", "long_running"]);
assert.equal(freezeFirst.artifacts[0]?.path, "local_runs/future-registration/market_freeze");
assert.equal(freezeFirst.artifacts[1]?.path, "local_runs/future-registration/decision");
assert.doesNotMatch(freezeFirst.displayCommand, new RegExp(escapeRegex(aoTemporaryRoot), "i"));

await assert.rejects(
  () => resolveWorkspaceAction({
    workspaceRoot: aoWorkspaceRoot,
    action: "ao_registered_python",
    preset: "freeze_first_execute",
    parameters: { ...freezeFirstParameters, bindingSha256: "0".repeat(64) },
    allowedRoots: [aoTemporaryRoot],
  }),
  /does not match bindingSha256/,
);

await assert.rejects(
  () => resolveWorkspaceAction({
    workspaceRoot: aoWorkspaceRoot,
    action: "ao_registered_python",
    preset: "execute",
    parameters: { ...aoExecuteParameters, command: "calc.exe" },
    allowedRoots: [aoTemporaryRoot],
  }),
  (error: unknown) => {
    assert.ok(error instanceof WorkspaceActionResolutionError);
    assert.equal(error.kind, "invalid_parameters");
    assert.match(error.message, /unsupported parameters: command/);
    return true;
  },
);

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

await assert.rejects(
  () => resolveWorkspaceAction({
    workspaceRoot: aoWorkspaceRoot,
    action: "ao_registered_python",
    preset: "execute",
    parameters: { ...aoExecuteParameters, windowOpenUtc: "2026-09-01 & calc.exe" },
    allowedRoots: [aoTemporaryRoot],
  }),
  (error: unknown) => {
    assert.ok(error instanceof WorkspaceActionResolutionError);
    assert.equal(error.kind, "invalid_parameters");
    assert.match(error.message, /canonical UTC format/);
    return true;
  },
);

await assert.rejects(
  () => resolveWorkspaceAction({
    workspaceRoot: aoWorkspaceRoot,
    action: "ao_registered_python",
    preset: "execute",
    parameters: { ...aoExecuteParameters, bindingPath: "..\\binding.json" },
    allowedRoots: [aoTemporaryRoot],
  }),
  (error: unknown) => {
    assert.ok(error instanceof WorkspaceActionResolutionError);
    assert.equal(error.kind, "invalid_parameters");
    assert.match(error.message, /must be an absolute path/);
    return true;
  },
);

await assert.rejects(
  () => resolveWorkspaceAction({
    workspaceRoot: aoWorkspaceRoot,
    action: "ao_registered_python",
    preset: "execute",
    parameters: { ...aoExecuteParameters, outputPath: join(aoTemporaryRoot, "outside-output") },
    allowedRoots: [aoTemporaryRoot],
  }),
  (error: unknown) => {
    assert.ok(error instanceof WorkspaceActionResolutionError);
    assert.equal(error.kind, "invalid_parameters");
    assert.match(error.message, /descendant of the selected producer workspace/);
    return true;
  },
);

const publishArtifact = await resolveWorkspaceAction({
  workspaceRoot: process.cwd(),
  action: "publish_artifact",
  parameters: { path: "dist/example.zip" },
});
assert.equal(publishArtifact.preset, "embedded_zip");
assert.deepEqual(publishArtifact.policy, ["read_only", "external_effect"]);
assert.deepEqual(publishArtifact.parameters, { path: "dist/example.zip" });
assert.equal(publishArtifact.plan, undefined);
assert.match(publishArtifact.command, /publish embedded ZIP/);

await assert.rejects(
  () => resolveWorkspaceAction({
    workspaceRoot: process.cwd(),
    action: "workspace_verify",
    executableEnvironment: { PATH: "", PATHEXT: ".COM;.EXE;.BAT;.CMD" },
  }),
  (error: unknown) => {
    assert.ok(error instanceof WorkspaceActionResolutionError);
    assert.equal(error.kind, "required_executable_missing");
    assert.match(error.message, /npm/);
    return true;
  },
);

await assert.rejects(
  () => resolveWorkspaceAction({
    workspaceRoot: process.cwd(),
    action: "unknown",
  }),
  (error: unknown) => {
    assert.ok(error instanceof WorkspaceActionResolutionError);
    assert.equal(error.kind, "unsupported_action");
    assert.equal(error.requestedAction, "unknown");
    assert.deepEqual(error.catalog.map((entry) => entry.action), [
      "workspace_verify",
      "workspace_review",
      "project_verify",
      "test_changed",
      "project_report",
      "ao_registered_python",
      "publish_artifact",
      "aegis_runner",
    ]);
    return true;
  },
);

await assert.rejects(
  () => resolveWorkspaceAction({
    workspaceRoot: process.cwd(),
    action: "workspace_verify",
    preset: "unknown",
  }),
  (error: unknown) => {
    assert.ok(error instanceof WorkspaceActionResolutionError);
    assert.equal(error.kind, "unsupported_preset");
    assert.equal(error.requestedPreset, "unknown");
    return true;
  },
);

await rm(aoTemporaryRoot, { recursive: true, force: true });

await assert.rejects(
  () => resolveWorkspaceAction({
    workspaceRoot: process.cwd(),
    action: "publish_artifact",
    parameters: {},
  }),
  (error: unknown) => {
    assert.ok(error instanceof WorkspaceActionResolutionError);
    assert.equal(error.kind, "invalid_parameters");
    assert.match(error.message, /requires a non-empty path parameter/);
    return true;
  },
);

await assert.rejects(
  () => resolveWorkspaceAction({
    workspaceRoot: process.cwd(),
    action: "project_verify",
    parameters: { unknown: true },
  }),
  (error: unknown) => {
    assert.ok(error instanceof WorkspaceActionResolutionError);
    assert.equal(error.kind, "invalid_parameters");
    assert.match(error.message, /accepts only the profile parameter: unknown/);
    return true;
  },
);

await assert.rejects(
  () => resolveWorkspaceAction({
    workspaceRoot: process.cwd(),
    action: "workspace_verify",
    parameters: { extra: true },
  }),
  (error: unknown) => {
    assert.ok(error instanceof WorkspaceActionResolutionError);
    assert.equal(error.kind, "invalid_parameters");
    assert.match(error.message, /does not accept parameters: extra/);
    return true;
  },
);
