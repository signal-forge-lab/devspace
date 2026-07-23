import assert from "node:assert/strict";
import {
  WorkspaceActionResolutionError,
  resolveWorkspaceAction,
  workspaceActionCatalog,
} from "./workspace-actions.js";

const catalog = workspaceActionCatalog();
assert.deepEqual(catalog.map((entry) => entry.action), ["workspace_verify"]);
assert.equal(catalog[0]?.defaultPreset, "standard");
assert.deepEqual(catalog[0]?.policy, ["read_only", "long_running"]);

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

await assert.rejects(
  () => resolveWorkspaceAction({
    workspaceRoot: process.cwd(),
    action: "unknown",
  }),
  (error: unknown) => {
    assert.ok(error instanceof WorkspaceActionResolutionError);
    assert.equal(error.kind, "unsupported_action");
    assert.equal(error.requestedAction, "unknown");
    assert.deepEqual(error.catalog.map((entry) => entry.action), ["workspace_verify"]);
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
