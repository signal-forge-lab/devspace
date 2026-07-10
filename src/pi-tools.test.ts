import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileTool } from "./pi-tools.js";

const root = await mkdtemp(join(tmpdir(), "devspace-pi-tools-test-"));
try {
  const response = await readFileTool(
    { path: "missing.txt" },
    { cwd: root, root },
  );
  assert.equal(response.isError, true);
  const message = response.content
    .filter((entry): entry is { type: "text"; text: string } => entry.type === "text")
    .map((entry) => entry.text)
    .join("\n");
  assert.doesNotMatch(message, new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(message, /<workspace>/);
} finally {
  await rm(root, { recursive: true, force: true });
}
