import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "./config.js";
import { editManyFiles } from "./edit-many.js";
import { WorkspaceRegistry } from "./workspaces.js";

const root = await mkdtemp(join(tmpdir(), "devspace-edit-many-test-"));
const outsideRoot = await mkdtemp(join(tmpdir(), "devspace-edit-many-outside-test-"));

try {
  await writeFile(join(root, "a.txt"), "alpha\nbeta\ngamma\n");
  await writeFile(join(root, "b.txt"), "one\ntwo\nthree\n");
  await writeFile(join(outsideRoot, "outside.txt"), "outside\n");

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

  const dryRun = await editManyFiles(
    {
      dryRun: true,
      files: [
        {
          path: "a.txt",
          edits: [{ oldText: "beta", newText: "BETA" }],
        },
        {
          path: "b.txt",
          edits: [{ oldText: "two", newText: "TWO" }],
        },
      ],
    },
    workspace,
    registry,
  );
  assert.equal(dryRun.status, "validated");
  assert.equal(dryRun.summary.requestedFiles, 2);
  assert.equal(dryRun.summary.editCount, 2);
  assert.equal(dryRun.summary.dryRun, true);
  assert.match(dryRun.result, /No files were changed/);
  assert.equal(await readFile(join(root, "a.txt"), "utf8"), "alpha\nbeta\ngamma\n");

  const applied = await editManyFiles(
    {
      files: [
        {
          path: "a.txt",
          edits: [{ oldText: "beta", newText: "BETA" }],
        },
        {
          path: "b.txt",
          edits: [{ oldText: "two", newText: "TWO" }],
        },
      ],
    },
    workspace,
    registry,
  );
  assert.equal(applied.status, "applied");
  assert.equal(applied.summary.requestedFiles, 2);
  assert.equal(applied.summary.editCount, 2);
  assert.equal(applied.summary.dryRun, false);
  assert.equal(await readFile(join(root, "a.txt"), "utf8"), "alpha\nBETA\ngamma\n");
  assert.equal(await readFile(join(root, "b.txt"), "utf8"), "one\nTWO\nthree\n");

  await assert.rejects(
    () => editManyFiles(
      {
        files: [
          {
            path: "a.txt",
            edits: [{ oldText: "missing", newText: "x" }],
          },
          {
            path: "b.txt",
            edits: [{ oldText: "three", newText: "THREE" }],
          },
        ],
      },
      workspace,
      registry,
    ),
    /matched 0 times/,
  );
  assert.equal(await readFile(join(root, "b.txt"), "utf8"), "one\nTWO\nthree\n");

  await writeFile(join(root, "dupe.txt"), "same\nsame\n", "utf8");
  await assert.rejects(
    () => editManyFiles(
      {
        dryRun: true,
        files: [
          {
            path: "dupe.txt",
            edits: [{ oldText: "same", newText: "SAME" }],
          },
        ],
      },
      workspace,
      registry,
    ),
    /Recommended fallback:[\s\S]*replace_symbol[\s\S]*insert_by_anchor[\s\S]*edit_by_line_range/,
  );

  await assert.rejects(
    () => editManyFiles(
      {
        files: [
          {
            path: "a.txt",
            edits: [{ oldText: "", newText: "x" }],
          },
        ],
      },
      workspace,
      registry,
    ),
    /oldText must not be empty/,
  );

  await assert.rejects(
    () => editManyFiles(
      {
        files: [
          {
            path: join(outsideRoot, "outside.txt"),
            edits: [{ oldText: "outside", newText: "inside" }],
          },
        ],
      },
      workspace,
      registry,
    ),
    /outside allowed roots|outside workspace root/i,
  );
} finally {
  await Promise.all([
    rm(root, { recursive: true, force: true }),
    rm(outsideRoot, { recursive: true, force: true }),
  ]);
}
