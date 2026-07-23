import assert from "node:assert/strict";
import {
  WorkspaceActionResolutionError,
  resolveWorkspaceAction,
  workspaceActionCatalog,
} from "./workspace-actions.js";

const catalog = workspaceActionCatalog();
assert.deepEqual(catalog.map((entry) => entry.action), ["workspace_verify", "workspace_review"]);
assert.equal(catalog[0]?.defaultPreset, "standard");
assert.deepEqual(catalog[0]?.policy, ["workspace_modify", "long_running"]);
assert.equal(catalog[1]?.defaultPreset, "summary");
assert.deepEqual(catalog[1]?.policy, ["read_only"]);
assert.deepEqual(catalog[1]?.presets.map((preset) => preset.name), ["summary", "integrity"]);

const resolved = await resolveWorkspaceAction({
  workspaceRoot: process.cwd(),
  action: "workspace_verify",
});
assert.equal(resolved.action, "workspace_verify");
assert.equal(resolved.preset, "standard");
assert.equal(resolved.executable, "shell");
assert.match(resolved.command, /npm run typecheck/);
assert.match(resolved.command, /npm run baseline:tools:check/);
assert.match(resolved.command, /npm test/);
assert.match(resolved.command, /npm run build/);
assert.match(resolved.command, /git diff --check/);
assert.match(resolved.command, /git status --short/);
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

await assert.rejects(
  () => resolveWorkspaceAction({
    workspaceRoot: process.cwd(),
    action: "unknown",
  }),
  (error: unknown) => {
    assert.ok(error instanceof WorkspaceActionResolutionError);
    assert.equal(error.kind, "unsupported_action");
    assert.equal(error.requestedAction, "unknown");
    assert.deepEqual(error.catalog.map((entry) => entry.action), ["workspace_verify", "workspace_review"]);
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
