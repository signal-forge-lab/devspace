import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveWorkspaceTask, workspaceTaskCatalog, workspaceTaskTemplateNames } from "./workspace-tasks.js";

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
assert.deepEqual(workspaceTaskTemplateNames("aegis_runner"), [
  "status_console_5s",
  "daemon_confirm_post",
  "daemon_confirm_post_bounded_10m",
  "request_pause",
  "resume_daemon",
]);

const daemon = await resolveWorkspaceTask({
  workspaceRoot: root,
  task: "aegis_runner",
  template: "daemon_confirm_post",
});
assert.deepEqual(daemon.args.slice(3), ["--daemon", "--confirm-post"]);

const boundedDaemon = await resolveWorkspaceTask({
  workspaceRoot: root,
  task: "aegis_runner",
  template: "daemon_confirm_post_bounded_10m",
});
assert.deepEqual(boundedDaemon.args.slice(3), [
  "--daemon",
  "--confirm-post",
  "--daemon-max-runtime-seconds",
  "600",
  "--daemon-poll-seconds",
  "10",
  "--daemon-heartbeat-seconds",
  "10",
]);

const pause = await resolveWorkspaceTask({
  workspaceRoot: root,
  task: "aegis_runner",
  template: "request_pause",
});
assert.deepEqual(pause.args.slice(3), ["--request-pause"]);

const resume = await resolveWorkspaceTask({
  workspaceRoot: root,
  task: "aegis_runner",
  template: "resume_daemon",
});
assert.deepEqual(resume.args.slice(3), ["--resume-daemon"]);

const catalog = await workspaceTaskCatalog(root);
assert.equal(catalog.length, 1);
assert.equal(catalog[0]?.name, "aegis_runner");
assert.equal(catalog[0]?.scriptPresent, true);
assert.equal(catalog[0]?.templates[0]?.name, "status_console_5s");
assert.equal(catalog[0]?.templates.length, 5);
assert.deepEqual(catalog[0]?.templates[0]?.args, [
  "--launch-status-console",
  "--status-console-refresh-seconds",
  "5",
]);

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
