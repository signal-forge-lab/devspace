import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import assert from "node:assert/strict";
import { resumeTaskCheckpoint, saveTaskCheckpoint } from "./task-checkpoints.js";

const root = await mkdtemp(join(tmpdir(), "devspace-checkpoint-"));
try {
  const saved = await saveTaskCheckpoint({
    workspaceId: "ws_test",
    root,
    title: "Long Task",
    objective: "finish safely",
    completed: ["planned"],
    pending: ["commit"],
    changedFiles: ["src/example.ts"],
  }, () => new Date("2026-06-24T10:00:00.000Z"));
  assert.equal(saved.checkpointId, "20260624100000_long-task");
  const resumed = await resumeTaskCheckpoint({ root });
  assert.equal(resumed.record?.objective, "finish safely");
  assert.match(resumed.result, /Pending: commit/);
} finally {
  await rm(root, { recursive: true, force: true });
}
