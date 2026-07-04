import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { loadConfig } from "./config.js";
import {
  gitCommitFilesTool,
  gitCommitStagedTool,
  gitDiffRangesTool,
  gitRecentCommitsTool,
  gitStageFilesTool,
  gitStageHunksTool,
  gitStatusTool,
} from "./git-tools.js";
import { WorkspaceRegistry } from "./workspaces.js";

const execFileAsync = promisify(execFile);
const root = await mkdtemp(join(tmpdir(), "devspace-git-tools-test-"));

async function git(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd: root });
  return stdout;
}

try {
  await git(["init"]);
  await git(["config", "user.email", "devspace-test@example.invalid"]);
  await git(["config", "user.name", "Workbridge Test"]);
  await writeFile(join(root, "tracked.txt"), "alpha\nbeta\ngamma\n");
  await git(["add", "tracked.txt"]);
  await git(["commit", "-m", "initial"]);

  const config = loadConfig({
    DEVSPACE_CONFIG_DIR: join(root, ".config"),
    DEVSPACE_ALLOWED_ROOTS: root,
    DEVSPACE_WORKTREE_ROOT: join(root, ".devspace", "worktrees"),
    DEVSPACE_AGENT_DIR: join(root, ".agent"),
    DEVSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
    PORT: "1",
  });
  const registry = new WorkspaceRegistry(config);
  const { workspace } = await registry.openWorkspace(root);

  await writeFile(join(root, "tracked.txt"), "alpha\nBETA\ngamma\nextra\n");
  await writeFile(join(root, "new.txt"), "new\n");

  const status = await gitStatusTool({}, workspace);
  assert.equal(status.unstagedFiles.includes("tracked.txt"), true);
  assert.equal(status.untrackedFiles.includes("new.txt"), true);

  const diffRanges = await gitDiffRangesTool({ files: ["tracked.txt"], contextLines: 1, maxLines: 20 }, workspace, registry);
  assert.equal(diffRanges.summary.fileCount, 1);
  assert.equal(diffRanges.summary.hunkCount, 1);
  assert.equal(diffRanges.files[0]?.path, "tracked.txt");
  assert.match(diffRanges.result, /git_diff_ranges unstaged/);
  assert.match(diffRanges.result, /BETA/);

  const recent = await gitRecentCommitsTool({ maxCount: 1 }, workspace);
  assert.equal(recent.commits.length, 1);
  assert.match(recent.commits[0] ?? "", /initial/);

  const dryRunHunks = await gitStageHunksTool(
    {
      dryRun: true,
      files: [
        {
          path: "tracked.txt",
          edits: [{ oldText: "beta", newText: "BETA" }],
        },
      ],
    },
    workspace,
    registry,
  );
  assert.equal(dryRunHunks.status, "validated");
  assert.equal((await git(["diff", "--cached", "--name-only"])).trim(), "");

  const stagedHunks = await gitStageHunksTool(
    {
      files: [
        {
          path: "tracked.txt",
          edits: [{ oldText: "beta", newText: "BETA" }],
        },
      ],
    },
    workspace,
    registry,
  );
  assert.equal(stagedHunks.status, "staged");
  const cachedDiff = await git(["diff", "--cached", "--", "tracked.txt"]);
  assert.match(cachedDiff, /BETA/);
  assert.doesNotMatch(cachedDiff, /extra/);

  const commitStaged = await gitCommitStagedTool(
    {
      message: "stage exact hunk",
      expectedFiles: ["tracked.txt"],
    },
    workspace,
    registry,
  );
  assert.equal(commitStaged.committed, true);
  assert.equal(commitStaged.subject, "stage exact hunk");
  assert.equal(await readFile(join(root, "tracked.txt"), "utf8"), "alpha\nBETA\ngamma\nextra\n");
  const remainingDiff = await git(["diff", "--", "tracked.txt"]);
  assert.match(remainingDiff, /extra/);

  const stageFiles = await gitStageFilesTool({ files: ["new.txt"] }, workspace, registry);
  assert.equal(stageFiles.stagedFiles.includes("new.txt"), true);

  const commitFiles = await gitCommitFilesTool(
    {
      files: ["tracked.txt", "new.txt"],
      message: "commit remaining files",
      allowExistingStaged: true,
    },
    workspace,
    registry,
  );
  assert.equal(commitFiles.committed, true);
  assert.equal(commitFiles.subject, "commit remaining files");
  assert.equal((await git(["status", "--short"])).trim(), "");

  await writeFile(join(root, "tracked.txt"), "alpha\nBETA\ngamma\nextra\nmore\n");
  await git(["add", "tracked.txt"]);
  await writeFile(join(root, "other.txt"), "other\n");
  await git(["add", "other.txt"]);
  await assert.rejects(
    () => gitCommitFilesTool(
      {
        files: ["tracked.txt"],
        message: "should fail",
      },
      workspace,
      registry,
    ),
    /unrelated files are already staged/,
  );
} finally {
  await rm(root, { recursive: true, force: true });
}
