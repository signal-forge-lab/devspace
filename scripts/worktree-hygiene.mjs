import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_CANONICAL_BRANCH = "workbridge-fixed-surface";

export function parseWorktreeList(text) {
  const worktrees = [];
  let current;
  for (const line of `${text}\n`.split(/\r?\n/)) {
    if (!line) {
      if (current?.path && current.head) worktrees.push(current);
      current = undefined;
      continue;
    }
    const [key, ...parts] = line.split(" ");
    const value = parts.join(" ");
    if (key === "worktree") current = { path: value, branch: undefined, detached: false };
    else if (!current) continue;
    else if (key === "HEAD") current.head = value;
    else if (key === "branch") current.branch = value.replace(/^refs\/heads\//, "");
    else if (key === "detached") current.detached = true;
  }
  return worktrees;
}

export function isManagedWorktreePath(value) {
  const normalized = String(value).replace(/\\/g, "/").toLowerCase();
  return /\/(?:\.workbridge|\.devspace)\/worktrees\//.test(normalized)
    || /\/\.devspace-pr-[^/]+\/worktrees\//.test(normalized);
}

export function classifyWorktree({ dirty, integrated, branch, refCount }) {
  if (dirty) return "keep-dirty";
  if (integrated) return "remove-integrated";
  if (branch) return "remove-worktree-keep-branch";
  if (refCount > 0) return "remove-worktree-ref-protected";
  return "archive-detached-before-remove";
}

export function classifyBranch({ checkedOut, upstream, integrated }) {
  if (checkedOut) return "keep-checked-out";
  if (upstream) return "keep-upstream";
  if (integrated) return "remove-integrated-branch";
  return "keep-unmerged-branch";
}

function git(args, options = {}) {
  return execFileSync("git", args, {
    cwd: options.cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", options.quiet ? "ignore" : "pipe"],
    windowsHide: true,
  }).trim();
}

function gitSucceeds(args, cwd) {
  try {
    git(args, { cwd, quiet: true });
    return true;
  } catch {
    return false;
  }
}

function isPatchEquivalent(branch, canonical, cwd) {
  if (!branch) return false;
  try {
    const lines = git(["cherry", canonical, branch], { cwd, quiet: true })
      .split(/\r?\n/)
      .filter(Boolean);
    return lines.length > 0 && lines.every((line) => line.startsWith("- "));
  } catch {
    return false;
  }
}

function inspectWorktree(worktree, canonical, cwd) {
  const dirty = git(["-C", worktree.path, "status", "--porcelain"], { cwd }).length > 0;
  const ancestor = gitSucceeds(["merge-base", "--is-ancestor", worktree.head, canonical], cwd);
  const integrated = ancestor || isPatchEquivalent(worktree.branch, canonical, cwd);
  const refs = git(["for-each-ref", "--format=%(refname)", "--contains", worktree.head], { cwd, quiet: true });
  const refCount = refs ? refs.split(/\r?\n/).length : 0;
  return {
    ...worktree,
    dirty,
    integrated,
    refCount,
    classification: classifyWorktree({ dirty, integrated, branch: worktree.branch, refCount }),
  };
}

function inspectBranches(worktrees, canonical, cwd) {
  const checkedOut = new Set(worktrees.map((worktree) => worktree.branch).filter(Boolean));
  const output = git([
    "for-each-ref",
    "--format=%(refname:short)%09%(objectname)%09%(upstream:short)",
    "refs/heads/",
  ], { cwd, quiet: true });
  if (!output) return [];
  return output.split(/\r?\n/).filter(Boolean).map((line) => {
    const [branch, head, upstream = ""] = line.split("\t");
    const ancestor = gitSucceeds(["merge-base", "--is-ancestor", head, canonical], cwd);
    const integrated = ancestor || isPatchEquivalent(branch, canonical, cwd);
    const branchCheckedOut = checkedOut.has(branch);
    return {
      branch,
      head,
      upstream,
      checkedOut: branchCheckedOut,
      integrated,
      classification: classifyBranch({ checkedOut: branchCheckedOut, upstream, integrated }),
    };
  });
}

export function auditWorktrees({ cwd = process.cwd(), canonical = DEFAULT_CANONICAL_BRANCH } = {}) {
  const root = git(["rev-parse", "--show-toplevel"], { cwd });
  const canonicalSha = git(["rev-parse", "--verify", canonical], { cwd: root });
  const allWorktrees = parseWorktreeList(git(["worktree", "list", "--porcelain"], { cwd: root }));
  const worktrees = allWorktrees
    .filter((worktree) => isManagedWorktreePath(worktree.path))
    .map((worktree) => inspectWorktree(worktree, canonicalSha, root));
  const branches = inspectBranches(allWorktrees, canonicalSha, root);
  return { root, canonical, canonicalSha, worktrees, branches };
}

function printAudit(audit) {
  console.log(`Worktree hygiene: ${audit.worktrees.length} managed worktree(s)`);
  for (const item of audit.worktrees) {
    console.log(`${item.classification}\t${item.branch ?? "(detached)"}\t${item.path}`);
  }
  console.log(`Branch hygiene: ${audit.branches.length} local branch(es)`);
  for (const item of audit.branches) {
    console.log(`${item.classification}\t${item.branch}${item.upstream ? `\t${item.upstream}` : ""}`);
  }
}

function main() {
  const args = process.argv.slice(2);
  const check = args.includes("--check");
  const canonicalArg = args.indexOf("--canonical");
  const canonical = canonicalArg >= 0 && args[canonicalArg + 1]
    ? args[canonicalArg + 1]
    : DEFAULT_CANONICAL_BRANCH;
  const audit = auditWorktrees({ canonical });
  printAudit(audit);
  const integratedWorktrees = audit.worktrees.filter((item) => item.classification === "remove-integrated");
  const integratedBranches = audit.branches.filter((item) => item.classification === "remove-integrated-branch");
  if (check && (integratedWorktrees.length > 0 || integratedBranches.length > 0)) {
    if (integratedWorktrees.length > 0) {
      console.error(`${integratedWorktrees.length} integrated managed worktree(s) should be removed before unrelated work continues.`);
    }
    if (integratedBranches.length > 0) {
      console.error(`${integratedBranches.length} integrated local branch(es) should be removed before unrelated work continues.`);
    }
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main();
}
