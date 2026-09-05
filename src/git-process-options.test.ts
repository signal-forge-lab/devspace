import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const gitWorktreesSource = await readFile(
  new URL("./git-worktrees.ts", import.meta.url),
  "utf8",
);
const gitSource = await readFile(new URL("./git.ts", import.meta.url), "utf8");

assertGitProcessIsHidden(gitWorktreesSource, "git-worktrees.ts");
assertGitProcessIsHidden(gitSource, "git.ts");

console.log("git process option tests passed");

function assertGitProcessIsHidden(source: string, fileName: string): void {
  const callStart = source.indexOf('execFileAsync("git", args, {');
  assert.notEqual(callStart, -1, `${fileName} must execute Git through execFileAsync.`);

  const callEnd = source.indexOf("});", callStart);
  assert.notEqual(callEnd, -1, `${fileName} Git execFileAsync call must be complete.`);
  assert.match(
    source.slice(callStart, callEnd),
    /windowsHide:\s*true/,
    `${fileName} must hide Git console windows on Windows.`,
  );
}
