import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { loadConfig } from "./config.js";
import { readManyFiles } from "./read-many.js";
import { workspaceSnapshot } from "./workspace-snapshot.js";
import { WorkspaceRegistry } from "./workspaces.js";

const execFileAsync = promisify(execFile);
const root = await mkdtemp(join(tmpdir(), "devspace-batched-tools-test-"));
const outsideRoot = await mkdtemp(
  join(tmpdir(), "devspace-batched-tools-outside-test-"),
);

try {
  const agentDir = join(root, ".agent");
  await mkdir(agentDir);
  await writeFile(join(root, "AGENTS.md"), "project instructions\n");
  await writeFile(join(root, "README.md"), "# Test project\n");
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({
      name: "snapshot-fixture",
      version: "1.2.3",
      type: "module",
      scripts: {
        test: "tsx test.ts",
        typecheck: "tsc --noEmit",
        build: "tsc",
      },
      dependencies: { alpha: "1.0.0" },
      devDependencies: { beta: "1.0.0" },
    }),
  );
  await writeFile(join(root, "first.txt"), "one\ntwo\nthree\n");
  await writeFile(join(root, "second.txt"), "alpha\nbeta\n");
  await writeFile(join(root, ".env"), "SECRET=not-read\n");
  await mkdir(join(root, "docs"));
  await writeFile(join(root, "docs", "guide.md"), "# Guide\n");
  await mkdir(join(root, "src", "nested"), { recursive: true });
  await writeFile(join(root, "src", "index.ts"), "export {};\n");
  await writeFile(join(root, "src", "nested", "feature.ts"), "export {};\n");
  await mkdir(join(root, "src", "node_modules"), { recursive: true });
  await writeFile(join(root, "src", "node_modules", "ignored.ts"), "ignored\n");
  await mkdir(join(root, "src", "dist"), { recursive: true });
  await writeFile(join(root, "src", "dist", "ignored.ts"), "ignored\n");
  await writeFile(join(outsideRoot, "outside.txt"), "outside\n");

  const config = loadConfig({
    DEVSPACE_CONFIG_DIR: join(root, ".config"),
    DEVSPACE_ALLOWED_ROOTS: root,
    DEVSPACE_WORKTREE_ROOT: join(root, ".devspace", "worktrees"),
    DEVSPACE_AGENT_DIR: agentDir,
    DEVSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
    PORT: "1",
  });
  const registry = new WorkspaceRegistry(config);
  const { workspace } = await registry.openWorkspace(root);

  const batch = await readManyFiles(
    {
      files: [
        { path: "first.txt", offset: 2, limit: 1 },
        { path: "second.txt" },
      ],
    },
    workspace,
    registry,
  );
  assert.equal(batch.summary.requested, 2);
  assert.equal(batch.summary.succeeded, 2);
  assert.equal(batch.summary.failed, 0);
  assert.equal(batch.summary.characters > 0, true);
  assert.equal(batch.summary.truncated, false);
  assert.equal(batch.files[0]?.limited, true);
  assert.equal(batch.files[1]?.limited, false);
  assert.match(batch.files[0]?.content ?? "", /two/);
  assert.doesNotMatch(batch.files[0]?.content ?? "", /one/);
  assert.match(batch.files[1]?.content ?? "", /alpha/);
  assert.match(batch.result, /# first\.txt/);
  assert.match(batch.result, /# second\.txt/);

  const failures = await readManyFiles(
    {
      files: [
        { path: "missing.txt" },
        { path: join(outsideRoot, "outside.txt") },
      ],
    },
    workspace,
    registry,
  );
  assert.equal(failures.summary.requested, 2);
  assert.equal(failures.summary.succeeded, 0);
  assert.equal(failures.summary.failed, 2);
  assert.equal(failures.files.every((file) => !file.ok), true);

  const bounded = await readManyFiles(
    {
      files: [{ path: "first.txt" }, { path: "second.txt" }],
      maxTotalCharacters: 5,
    },
    workspace,
    registry,
  );
  assert.equal(bounded.summary.characters, 5);
  assert.equal(bounded.summary.truncated, true);
  assert.equal(
    bounded.files.reduce(
      (total, file) => total + (file.content?.length ?? 0),
      0,
    ),
    5,
  );

  const boundedFailure = await readManyFiles(
    {
      files: [{ path: "first.txt" }, { path: "missing.txt" }],
      maxTotalCharacters: 5,
    },
    workspace,
    registry,
  );
  assert.equal(boundedFailure.summary.failed, 1);
  assert.equal(boundedFailure.files[1]?.ok, false);

  const nonGitSnapshot = await workspaceSnapshot(workspace);
  assert.equal(nonGitSnapshot.git?.isGitRepo, false);
  assert.equal(nonGitSnapshot.readmePresent, true);
  assert.equal(nonGitSnapshot.packageJsonPresent, true);
  assert.equal(nonGitSnapshot.agents?.agentsMd, true);
  assert.equal(nonGitSnapshot.packageJson?.name, "snapshot-fixture");
  assert.deepEqual(nonGitSnapshot.packageJson?.dependencies, ["alpha"]);
  assert.deepEqual(nonGitSnapshot.packageJson?.devDependencies, ["beta"]);
  assert.deepEqual(nonGitSnapshot.testCommandCandidates, [
    "npm test",
    "npm run typecheck",
    "npm run build",
  ]);
  assert.equal(nonGitSnapshot.topLevelFiles?.includes(".env"), false);
  assert.deepEqual(nonGitSnapshot.docsFiles, ["docs/guide.md"]);
  assert.deepEqual(nonGitSnapshot.srcFiles, [
    "src/index.ts",
    "src/nested/feature.ts",
  ]);

  const limitedSnapshot = await workspaceSnapshot(workspace, { maxFiles: 2 });
  assert.equal(limitedSnapshot.summary.files, 2);
  assert.equal(limitedSnapshot.summary.truncated, true);

  await execFileAsync("git", ["init"], { cwd: root });
  const gitSnapshot = await workspaceSnapshot(workspace);
  assert.equal(gitSnapshot.git?.isGitRepo, true);
  assert.equal(Array.isArray(gitSnapshot.git?.status), true);
} finally {
  await Promise.all([
    rm(root, { recursive: true, force: true }),
    rm(outsideRoot, { recursive: true, force: true }),
  ]);
}
