import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileOutline, grepContext } from "./structured-inspection.js";
import type { Workspace } from "./workspaces.js";

const root = await mkdtemp(join(tmpdir(), "devspace-structured-inspection-test-"));
try {
  await mkdir(join(root, "src"), { recursive: true });
  await mkdir(join(root, "node_modules", "ignored"), { recursive: true });
  await writeFile(
    join(root, "src", "example.ts"),
    [
      "export interface Thing {",
      "  name: string;",
      "}",
      "",
      "export async function buildThing(name: string) {",
      "  return { name };",
      "}",
      "",
      "const helper = () => buildThing('demo');",
      "",
      "class Worker {",
      "  run() {",
      "    return helper();",
      "  }",
      "}",
    ].join("\n"),
  );
  await writeFile(join(root, "src", "notes.md"), "# Notes\n\nBuildThing is mentioned here.\n");
  await writeFile(join(root, "node_modules", "ignored", "skip.ts"), "buildThing should not be searched\n");

  const workspace = {
    id: "ws_test",
    root,
    mode: "checkout",
    skills: [],
    skillDiagnostics: [],
    activatedSkillDirs: new Set<string>(),
  } as Workspace;

  const grep = await grepContext(
    {
      query: "buildThing",
      path: "src",
      contextLines: 1,
      maxMatches: 10,
    },
    workspace,
  );
  assert.equal(grep.summary.matches, 3);
  assert.equal(grep.summary.matchedFiles, 2);
  assert.equal(grep.matches[0].path, "src/example.ts");
  assert.equal(grep.matches[0].line, 5);
  assert.equal(grep.matches[0].context.length, 3);
  assert.ok(grep.result.includes("src/example.ts:5"));

  const regex = await grepContext(
    {
      query: "buildThing\\(",
      regex: true,
      path: "src/example.ts",
      contextLines: 0,
    },
    workspace,
  );
  assert.equal(regex.summary.matches, 2);

  const outline = await fileOutline({ path: "src/example.ts" }, workspace);
  assert.deepEqual(
    outline.symbols.map((symbol) => [symbol.kind, symbol.name, symbol.line]),
    [
      ["interface", "Thing", 1],
      ["function", "buildThing", 5],
      ["const-function", "helper", 9],
      ["class", "Worker", 11],
      ["method", "run", 12],
    ],
  );
  assert.ok(outline.result.includes("function export | buildThing"));
} finally {
  await rm(root, { recursive: true, force: true });
}
