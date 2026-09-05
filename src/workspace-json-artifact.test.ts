import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeWorkspaceJsonArtifact } from "./workspace-json-artifact.js";

const root = await mkdtemp(join(tmpdir(), "workbridge-json-artifact-test-"));
try {
  await writeWorkspaceJsonArtifact(root, ".workbridge/reports/profile.json", {
    profile: "node",
  });
  const contents = JSON.parse(
    await readFile(join(root, ".workbridge", "reports", "profile.json"), "utf8"),
  ) as { profile?: unknown };
  assert.equal(contents.profile, "node");

  await Promise.all(Array.from({ length: 64 }, (_, index) =>
    writeWorkspaceJsonArtifact(root, `.workbridge/concurrent/report-${index}.json`, { index })));
  assert.equal((await readdir(join(root, ".workbridge", "concurrent"))).length, 64);

  await assert.rejects(
    () => writeWorkspaceJsonArtifact(root, ".workbridge/reports/profile.json", {}),
    /EEXIST/,
  );
  await assert.rejects(
    () => writeWorkspaceJsonArtifact(root, "../outside.json", {}),
    /stay inside the workspace/,
  );
  await assert.rejects(
    () => writeWorkspaceJsonArtifact(root, "folder/", {}),
    /relative path/,
  );
  await assert.rejects(
    () => writeWorkspaceJsonArtifact(root, "undefined.json", undefined),
    /JSON serializable/,
  );
} finally {
  await rm(root, { recursive: true, force: true });
}
