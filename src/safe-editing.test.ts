import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import assert from "node:assert/strict";
import { bashPreflight, editByLineRange, editPlanPreflight, editPreflightIndex, insertByAnchor, replaceSymbol } from "./safe-editing.js";

const dir = await mkdtemp(join(tmpdir(), "devspace-safe-edit-"));
try {
  const preflight = editPlanPreflight({
    plannedTool: "edit",
    edits: [{ oldChars: 10_000, newText: "<script>${x}</script>" }],
  });
  assert.equal(preflight.risk, "high");
  assert.ok(preflight.saferTools.includes("edit_by_line_range"));

  const symbolPreflight = editPlanPreflight({
    plannedTool: "edit_by_line_range",
    targetKind: "function",
    symbol: "toolNamesFor",
  });
  assert.equal(symbolPreflight.recommendedStrategy, "replace_named_symbol");
  assert.ok(symbolPreflight.saferTools.includes("replace_symbol"));
  assert.match(symbolPreflight.result, /Target symbol: toolNamesFor/);

  const lineFile = join(dir, "lines.txt");
  await writeFile(lineFile, "one\ntwo\nthree\n", "utf8");
  const preflightIndex = await editPreflightIndex({ path: "lines.txt", absolutePath: lineFile, startLine: 2, endLine: 2, oldText: "two", newText: "TWO\n" });
  assert.equal(preflightIndex.risk, "low");
  assert.equal(preflightIndex.oldTextMatches, 1);
  assert.ok(preflightIndex.selectedHash);

  const riskyBash = bashPreflight({ command: "git diff && sed -n '1,40p' src/server.ts" });
  assert.equal(riskyBash.risk, "high");
  assert.ok(riskyBash.saferTools.includes("git_diff_ranges"));

  const dry = await editByLineRange({ path: "lines.txt", absolutePath: lineFile, startLine: 2, endLine: 2, newText: "TWO\n", dryRun: true });
  assert.equal(dry.status, "validated");
  assert.equal(await readFile(lineFile, "utf8"), "one\ntwo\nthree\n");
  await editByLineRange({ path: "lines.txt", absolutePath: lineFile, startLine: 2, endLine: 2, newText: "TWO\n", expectedHash: dry.selectedHash });
  assert.equal(await readFile(lineFile, "utf8"), "one\nTWO\nthree\n");

  const anchorFile = join(dir, "anchor.txt");
  await writeFile(anchorFile, "before\nANCHOR\nafter\n", "utf8");
  await insertByAnchor({ path: "anchor.txt", absolutePath: anchorFile, anchor: "ANCHOR\n", position: "after", content: "inserted\n" });
  assert.equal(await readFile(anchorFile, "utf8"), "before\nANCHOR\ninserted\nafter\n");

  const symbolFile = join(dir, "symbol.ts");
  await writeFile(symbolFile, "function keep() { return 1; }\nfunction target() {\n  return 2;\n}\n", "utf8");
  const symbolDry = await replaceSymbol({ path: "symbol.ts", absolutePath: symbolFile, symbol: "target", kind: "function", newText: "function target() {\n  return 42;\n}", dryRun: true });
  assert.equal(symbolDry.status, "validated");
  await assert.rejects(
    () => replaceSymbol({ path: "symbol.ts", absolutePath: symbolFile, symbol: "target", kind: "function", newText: "function target() {\n  return 99;\n}", expectedHash: "bad-hash" }),
    /Symbol range hash mismatch/,
  );
  await replaceSymbol({ path: "symbol.ts", absolutePath: symbolFile, symbol: "target", kind: "function", newText: "function target() {\n  return 42;\n}", expectedHash: symbolDry.selectedHash });
  assert.match(await readFile(symbolFile, "utf8"), /return 42/);
} finally {
  await rm(dir, { recursive: true, force: true });
}
