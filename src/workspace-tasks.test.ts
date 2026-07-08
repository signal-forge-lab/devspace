import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resolveWorkspaceTask, resetWorkspaceTaskConfigForTest } from "./workspace-tasks.js";

const workspaceRoot = await mkdtemp(join(tmpdir(), "devspace-workspace-tasks-test-"));
await writeFile(join(workspaceRoot, "aegis_runner.py"), "print('ok')\n", "utf8");

const resolved = await resolveWorkspaceTask({
  workspaceRoot,
  task: "aegis_runner",
  args: ["--open-mission-archive-finalize-ui"],
});

assert.ok(resolved.command.includes(workspaceRoot));
assert.ok(!resolved.displayCommand.includes(workspaceRoot));
assert.ok(resolved.displayCommand.includes("<workspace>/aegis_runner.py"));
assert.ok(resolved.displayCommand.includes("--open-mission-archive-finalize-ui"));

const templatedWorkspaceRoot = await mkdtemp(join(tmpdir(), "devspace-workspace-tasks-template-test-"));
await writeFile(join(templatedWorkspaceRoot, "aegis_runner.py"), "print('ok')\n", "utf8");
await mkdir(join(templatedWorkspaceRoot, ".workbridge"));
await writeFile(
  join(templatedWorkspaceRoot, ".workbridge", "workspace-tasks.json"),
  JSON.stringify({
    tasks: {
      aegis_runner: {
        templates: {
          mission_archive_finalize_ui_check: {
            args: ["--open-mission-archive-finalize-ui"],
            description: "Check archive finalize UI.",
          },
        },
      },
    },
  }),
  "utf8",
);

resetWorkspaceTaskConfigForTest();
const templated = await resolveWorkspaceTask({
  workspaceRoot: templatedWorkspaceRoot,
  task: "aegis_runner",
  template: "mission_archive_finalize_ui_check",
});

assert.ok(templated.command.includes(templatedWorkspaceRoot));
assert.ok(!templated.displayCommand.includes(templatedWorkspaceRoot));
assert.ok(templated.displayCommand.includes("<workspace>/aegis_runner.py"));
assert.ok(templated.displayCommand.includes("--open-mission-archive-finalize-ui"));
