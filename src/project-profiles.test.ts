import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  ProjectProfileResolutionError,
  resolveProjectVerifyProfile,
} from "./project-profiles.js";

const execFileAsync = promisify(execFile);

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
  await mkdir(nodeRoot, { recursive: true });
  await execFileAsync("git", ["init", nodeRoot], { windowsHide: true });
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
  assert.match(node.evidence.join("\n"), /package manager: npm/);

  const nodeQuick = await resolveProjectVerifyProfile({
    workspaceRoot: nodeRoot,
    preset: "quick",
  });
  assert.equal(
    nodeQuick.command,
    "npm run typecheck && npm run test && git diff --check && git status --short",
  );
  assert.doesNotMatch(nodeQuick.command, /npm run build/);

  const pnpmRoot = join(root, "pnpm");
  await mkdir(pnpmRoot, { recursive: true });
  await writeFile(
    join(pnpmRoot, "package.json"),
    JSON.stringify({
      packageManager: "pnpm@10.0.0",
      scripts: { lint: "eslint .", test: "vitest run" },
    }),
  );
  await writeFile(join(pnpmRoot, "package-lock.json"), "{}\n");
  const pnpm = await resolveProjectVerifyProfile({ workspaceRoot: pnpmRoot });
  assert.equal(pnpm.command, "pnpm run lint && pnpm run test");
  assert.match(pnpm.evidence.join("\n"), /package manager: pnpm/);

  const yarnRoot = join(root, "yarn");
  await mkdir(yarnRoot, { recursive: true });
  await writeFile(join(yarnRoot, "package.json"), JSON.stringify({ scripts: { build: "vite build" } }));
  await writeFile(join(yarnRoot, "yarn.lock"), "# yarn lockfile\n");
  const yarn = await resolveProjectVerifyProfile({ workspaceRoot: yarnRoot });
  assert.equal(yarn.command, "yarn run build");

  const bunRoot = join(root, "bun");
  await mkdir(bunRoot, { recursive: true });
  await writeFile(join(bunRoot, "package.json"), JSON.stringify({ scripts: { test: "bun test" } }));
  await writeFile(join(bunRoot, "bun.lock"), "lockfileVersion = 1\n");
  const bun = await resolveProjectVerifyProfile({ workspaceRoot: bunRoot });
  assert.equal(bun.command, "bun run test");

  const ambiguousRoot = join(root, "ambiguous-manager");
  await mkdir(ambiguousRoot, { recursive: true });
  await writeFile(join(ambiguousRoot, "package.json"), JSON.stringify({ scripts: { test: "node test.js" } }));
  await writeFile(join(ambiguousRoot, "package-lock.json"), "{}\n");
  await writeFile(join(ambiguousRoot, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
  await assert.rejects(
    () => resolveProjectVerifyProfile({ workspaceRoot: ambiguousRoot }),
    (error: unknown) => {
      assert.ok(error instanceof ProjectProfileResolutionError);
      assert.equal(error.kind, "ambiguous_package_manager");
      return true;
    },
  );

  const unsupportedManagerRoot = join(root, "unsupported-manager");
  await mkdir(unsupportedManagerRoot, { recursive: true });
  await writeFile(
    join(unsupportedManagerRoot, "package.json"),
    JSON.stringify({ packageManager: "deno@2.0.0", scripts: { test: "deno test" } }),
  );
  await assert.rejects(
    () => resolveProjectVerifyProfile({ workspaceRoot: unsupportedManagerRoot }),
    (error: unknown) => {
      assert.ok(error instanceof ProjectProfileResolutionError);
      assert.equal(error.kind, "unsupported_package_manager");
      return true;
    },
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
