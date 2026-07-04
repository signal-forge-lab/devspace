import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { WorkspaceIndexStore } from "./workspace-index.js";
import type { Workspace } from "./workspaces.js";

const execFileAsync = promisify(execFile);
const root = await mkdtemp(join(tmpdir(), "devspace-workspace-index-"));
try {
  await mkdir(join(root, "docs"), { recursive: true });
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(join(root, "AGENTS.md"), "a1\na2\na3\na4\n", "utf8");
  await writeFile(join(root, "docs", "guide.md"), "g1\ng2\ng3\n", "utf8");
  await writeFile(join(root, "src", "index.ts"), "s1\ns2\ns3\ns4\ns5\ns6-changed\n", "utf8");
  await writeFile(join(root, ".env"), "SECRET=ignored\n", "utf8");
  await execFileAsync("git", ["init"], { cwd: root });
  await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: root });
  await execFileAsync("git", ["config", "user.name", "Test User"], { cwd: root });
  await execFileAsync("git", ["add", "AGENTS.md", "docs/guide.md", "src/index.ts", ".env"], { cwd: root });
  await execFileAsync("git", ["commit", "-m", "init"], { cwd: root });

  const workspace: Workspace = {
    id: "ws_index_test",
    root,
    mode: "checkout",
    skills: [],
    skillDiagnostics: [],
    activatedSkillDirs: new Set(),
  };
  const store = new WorkspaceIndexStore();
  const index = await store.createWorkspaceIndex(workspace, {
    includePaths: ["AGENTS.md", "docs/guide.md", "src/index.ts"],
    maxPreviewFiles: 10,
  });
  assert.equal(index.workspaceId, workspace.id);
  assert.equal(index.fileCount, 3);
  assert.equal(index.entries[0]?.number, 1);
  assert.equal(index.entries[0]?.path, "AGENTS.md");
  assert.equal(index.entries[1]?.path, "docs/guide.md");
  assert.equal(index.entries[2]?.path, "src/index.ts");
  assert.match(index.result, /1\tAGENTS\.md/);
  assert.deepEqual(store.resolveIndexPaths(workspace, { indexId: index.indexId, numbers: [3, 1, 3] }), [
    "src/index.ts",
    "AGENTS.md",
  ]);
  assert.deepEqual(store.resolveIndexPaths(workspace, { indexId: index.indexId }), [
    "AGENTS.md",
    "docs/guide.md",
    "src/index.ts",
  ]);

  assert.equal(index.reused, false);
  assert.equal(index.source, "created");
  assert.equal(index.staleReason, "cache_miss");

  const reused = await store.createWorkspaceIndex(workspace, {
    includePaths: ["AGENTS.md", "docs/guide.md", "src/index.ts"],
    maxPreviewFiles: 10,
  });
  assert.equal(reused.indexId, index.indexId);
  assert.equal(reused.reused, true);
  assert.equal(reused.source, "cache");
  assert.equal(reused.previewCount, 0);
  assert.equal(reused.entries.length, 0);
  assert.match(reused.result, /Reused workspace index/);

  const reusedWithPreview = await store.createWorkspaceIndex(workspace, {
    includePaths: ["AGENTS.md", "docs/guide.md", "src/index.ts"],
    maxPreviewFiles: 10,
    includePreview: true,
  });
  assert.equal(reusedWithPreview.indexId, index.indexId);
  assert.equal(reusedWithPreview.previewCount, 3);
  assert.equal(reusedWithPreview.entries[0]?.path, "AGENTS.md");

  const refreshed = await store.createWorkspaceIndex(workspace, {
    includePaths: ["AGENTS.md", "docs/guide.md", "src/index.ts"],
    maxPreviewFiles: 10,
    refresh: true,
  });
  assert.notEqual(refreshed.indexId, index.indexId);
  assert.equal(refreshed.reused, false);
  assert.equal(refreshed.staleReason, "refresh_requested");

  await writeFile(join(root, "src", "index.ts"), "s1\ns2\ns3\ns4\ns5\ns6-changed\n", "utf8");
  const changed = await store.createWorkspaceIndex(workspace, {
    includePaths: ["AGENTS.md", "docs/guide.md", "src/index.ts"],
    maxPreviewFiles: 10,
  });
  assert.notEqual(changed.indexId, refreshed.indexId);
  assert.equal(changed.source, "created");

  const ranges = await store.readIndexRanges(workspace, {
    indexId: index.indexId,
    spec: "1;L2-L3,3;L4-L5",
  });
  assert.equal(ranges.summary.requested, 2);
  assert.equal(ranges.summary.succeeded, 2);
  assert.equal(ranges.ranges[0]?.path, "AGENTS.md");
  assert.match(ranges.ranges[0]?.content ?? "", /a2\na3/);
  assert.match(ranges.ranges[1]?.content ?? "", /s4\ns5/);
  assert.match(ranges.result, /# \[1\] AGENTS\.md L2-L3/);

  const structuredRanges = await store.readIndexRanges(workspace, {
    indexId: index.indexId,
    ranges: [{ number: 2, startLine: 1, endLine: 2 }],
  });
  assert.equal(structuredRanges.summary.requested, 1);
  assert.equal(structuredRanges.ranges[0]?.path, "docs/guide.md");
  assert.match(structuredRanges.ranges[0]?.content ?? "", /g1\ng2/);

  const colonSpecRanges = await store.readIndexRanges(workspace, {
    indexId: index.indexId,
    spec: "3:4-5",
  });
  assert.equal(colonSpecRanges.summary.succeeded, 1);
  assert.match(colonSpecRanges.ranges[0]?.content ?? "", /s4\ns5/);

  const bounded = await store.readIndexRanges(workspace, {
    indexId: index.indexId,
    spec: "1;L1-L4,2;L1-L3",
    maxTotalCharacters: 5,
  });
  assert.equal(bounded.summary.truncated, true);
  assert.equal(bounded.summary.characters, 5);

  await assert.rejects(
    () => store.createWorkspaceIndex(workspace, { includePaths: ["../outside.txt"] }),
    /Unsafe workspace path/,
  );
  await assert.rejects(
    () => store.readIndexRanges(workspace, { indexId: index.indexId }),
    /requires either spec or ranges/,
  );
  await assert.rejects(
    () => store.readIndexRanges(workspace, { indexId: index.indexId, ranges: [{ number: 0, startLine: 1, endLine: 1 }] }),
    /ranges\[0\]\.number must be a positive integer/,
  );
  await assert.rejects(
    () => store.readIndexRanges(workspace, { indexId: index.indexId, spec: "bad" }),
    /Invalid range spec part/,
  );
  await assert.rejects(
    () => store.readIndexRanges({ ...workspace, id: "ws_other" }, { indexId: index.indexId, spec: "1;L1-L1" }),
    /different workspace/,
  );
} finally {
  await rm(root, { recursive: true, force: true });
}
