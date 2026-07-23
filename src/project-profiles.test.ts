import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ProjectProfileResolutionError,
  resolveProjectVerifyProfile,
} from "./project-profiles.js";

const root = await mkdtemp(join(tmpdir(), "workbridge-project-profiles-test-"));
try {
  const workbridgeRoot = join(root, "workbridge");
  await mkdir(join(workbridgeRoot, "src"), { recursive: true });
  await writeFile(
    join(workbridgeRoot, "package.json"),
    JSON.stringify({ name: "@waishnav/devspace", scripts: { test: "node test.js" } }),
  );
  await writeFile(join(workbridgeRoot, "src", "workspace-actions.ts"), "export {};\n");

  const workbridge = await resolveProjectVerifyProfile({ workspaceRoot: workbridgeRoot });
  assert.equal(workbridge.profile, "workbridge");
  assert.equal(workbridge.confidence, "exact");
  assert.match(workbridge.command, /npm run baseline:tools:check/);
  assert.deepEqual(workbridge.policy, ["workspace_modify", "long_running"]);

  const forcedNode = await resolveProjectVerifyProfile({
    workspaceRoot: workbridgeRoot,
    requestedProfile: "node",
  });
  assert.equal(forcedNode.profile, "node");
  assert.equal(forcedNode.command, "npm run test");

  const nodeRoot = join(root, "node");
  await mkdir(join(nodeRoot, ".git"), { recursive: true });
  await writeFile(
    join(nodeRoot, "package.json"),
    JSON.stringify({
      name: "example-node-project",
      scripts: {
        build: "node build.js",
        test: "node test.js",
        custom: "node custom.js",
        typecheck: "tsc --noEmit",
      },
    }),
  );
  const node = await resolveProjectVerifyProfile({ workspaceRoot: nodeRoot });
  assert.equal(node.profile, "node");
  assert.equal(
    node.command,
    "npm run typecheck && npm run test && npm run build && git diff --check && git status --short",
  );

  await assert.rejects(
    () => resolveProjectVerifyProfile({
      workspaceRoot: nodeRoot,
      requestedProfile: "workbridge",
    }),
    (error: unknown) => {
      assert.ok(error instanceof ProjectProfileResolutionError);
      assert.equal(error.kind, "unsupported_project_profile");
      return true;
    },
  );

  await assert.rejects(
    () => resolveProjectVerifyProfile({
      workspaceRoot: nodeRoot,
      requestedProfile: "python",
    }),
    (error: unknown) => {
      assert.ok(error instanceof ProjectProfileResolutionError);
      assert.equal(error.kind, "unsupported_project_profile");
      return true;
    },
  );

  const emptyNodeRoot = join(root, "empty-node");
  await mkdir(emptyNodeRoot, { recursive: true });
  await writeFile(join(emptyNodeRoot, "package.json"), JSON.stringify({ scripts: { custom: "echo custom" } }));
  await assert.rejects(
    () => resolveProjectVerifyProfile({ workspaceRoot: emptyNodeRoot }),
    (error: unknown) => {
      assert.ok(error instanceof ProjectProfileResolutionError);
      assert.equal(error.kind, "unsupported_action_for_profile");
      return true;
    },
  );

  const invalidRoot = join(root, "invalid");
  await mkdir(invalidRoot, { recursive: true });
  await writeFile(join(invalidRoot, "package.json"), "not-json");
  await assert.rejects(
    () => resolveProjectVerifyProfile({ workspaceRoot: invalidRoot }),
    (error: unknown) => {
      assert.ok(error instanceof ProjectProfileResolutionError);
      assert.equal(error.kind, "invalid_project_manifest");
      return true;
    },
  );

  const unsupportedRoot = join(root, "unsupported");
  await mkdir(unsupportedRoot, { recursive: true });
  await assert.rejects(
    () => resolveProjectVerifyProfile({ workspaceRoot: unsupportedRoot }),
    (error: unknown) => {
      assert.ok(error instanceof ProjectProfileResolutionError);
      assert.equal(error.kind, "unsupported_project_profile");
      return true;
    },
  );
} finally {
  await rm(root, { recursive: true, force: true });
}
