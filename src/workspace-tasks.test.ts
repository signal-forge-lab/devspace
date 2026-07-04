import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveWorkspaceTask, workspaceTaskTemplateNames } from "./workspace-tasks.js";

const root = mkdtempSync(join(tmpdir(), "workbridge-task-"));
writeFileSync(join(root, "aegis_runner.py"), "print('ok')\n", "utf8");

const dynamic = await resolveWorkspaceTask({
  workspaceRoot: root,
  task: "aegis_runner",
  args: ["--status"],
  pythonCommand: "python-test",
});

assert.equal(dynamic.task, "aegis_runner");
assert.equal(dynamic.executable, "python-test");
assert.deepEqual(dynamic.args.slice(0, 3), ["-X", "utf8", join(root, "aegis_runner.py")]);
assert.deepEqual(dynamic.args.slice(3), ["--status"]);
assert.match(dynamic.command, /python-test/);
assert.match(dynamic.command, /--status/);

const templated = await resolveWorkspaceTask({
  workspaceRoot: root,
  task: "aegis_runner",
  template: "status_console_5s",
});

assert.deepEqual(templated.args.slice(3), [
  "--launch-status-console",
  "--status-console-refresh-seconds",
  "5",
]);
assert.deepEqual(workspaceTaskTemplateNames("aegis_runner"), ["status_console_5s"]);

const combined = await resolveWorkspaceTask({
  workspaceRoot: root,
  task: "aegis_runner",
  template: "status_console_5s",
  args: ["--extra"],
});
assert.equal(combined.args.at(-1), "--extra");

await assert.rejects(
  resolveWorkspaceTask({ workspaceRoot: root, task: "unknown" }),
  /Unsupported workspace task/,
);

await assert.rejects(
  resolveWorkspaceTask({ workspaceRoot: root, task: "aegis_runner", template: "unknown" }),
  /Unsupported template/,
);
