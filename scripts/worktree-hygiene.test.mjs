import assert from "node:assert/strict";
import {
  classifyBranch,
  classifyWorktree,
  isManagedWorktreePath,
  parseWorktreeList,
} from "./worktree-hygiene.mjs";

assert.deepEqual(parseWorktreeList([
  "worktree C:/repo/worktree-a",
  "HEAD aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "branch refs/heads/feature/a",
  "",
  "worktree C:/repo/worktree-b",
  "HEAD bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  "detached",
  "",
].join("\n")), [
  {
    path: "C:/repo/worktree-a",
    head: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    branch: "feature/a",
    detached: false,
  },
  {
    path: "C:/repo/worktree-b",
    head: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    branch: undefined,
    detached: true,
  },
]);

assert.equal(isManagedWorktreePath("C:\\Users\\me\\.workbridge\\worktrees\\workbridge-a"), true);
assert.equal(isManagedWorktreePath("C:/Users/me/.devspace/worktrees/workbridge-a"), true);
assert.equal(isManagedWorktreePath("C:/Users/me/.devspace-pr-test/worktrees/workbridge-a"), true);
assert.equal(isManagedWorktreePath("C:/Users/me/github/workbridge"), false);

assert.equal(classifyWorktree({ dirty: true, integrated: true, branch: "feature/a", refCount: 1 }), "keep-dirty");
assert.equal(classifyWorktree({ dirty: false, integrated: true, branch: "feature/a", refCount: 1 }), "remove-integrated");
assert.equal(classifyWorktree({ dirty: false, integrated: false, branch: "feature/a", refCount: 1 }), "remove-worktree-keep-branch");
assert.equal(classifyWorktree({ dirty: false, integrated: false, branch: undefined, refCount: 1 }), "remove-worktree-ref-protected");
assert.equal(classifyWorktree({ dirty: false, integrated: false, branch: undefined, refCount: 0 }), "archive-detached-before-remove");

assert.equal(classifyBranch({ checkedOut: true, upstream: "", integrated: true }), "keep-checked-out");
assert.equal(classifyBranch({ checkedOut: false, upstream: "origin/feature/a", integrated: true }), "keep-upstream");
assert.equal(classifyBranch({ checkedOut: false, upstream: "", integrated: true }), "remove-integrated-branch");
assert.equal(classifyBranch({ checkedOut: false, upstream: "", integrated: false }), "keep-unmerged-branch");

console.log("worktree hygiene tests passed");
