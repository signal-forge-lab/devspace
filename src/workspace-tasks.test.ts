import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetWorkspaceTaskConfigForTest, resolveWorkspaceTask, workspaceTaskCatalog, workspaceTaskTemplateNames } from "./workspace-tasks.js";

const originalWorkspaceTasksConfig = process.env.WORKBRIDGE_WORKSPACE_TASKS_CONFIG;
const root = mkdtempSync(join(tmpdir(), "workbridge-task-"));
writeFileSync(join(root, "aegis_runner.py"), "print('ok')\n", "utf8");

process.env.WORKBRIDGE_WORKSPACE_TASKS_CONFIG = join(root, "missing-workspace-tasks.json");
resetWorkspaceTaskConfigForTest();

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
assert.deepEqual(workspaceTaskTemplateNames("aegis_runner"), []);

const catalogWithoutConfig = await workspaceTaskCatalog(root);
assert.equal(catalogWithoutConfig.length, 1);
assert.equal(catalogWithoutConfig[0]?.name, "aegis_runner");
assert.equal(catalogWithoutConfig[0]?.scriptPresent, true);
assert.equal(catalogWithoutConfig[0]?.templates.length, 0);

await assert.rejects(
  resolveWorkspaceTask({ workspaceRoot: root, task: "aegis_runner", template: "status_console_5s" }),
  /Unsupported template/,
);

mkdirSync(join(root, ".workbridge"));
const configPath = join(root, ".workbridge", "workspace-tasks.json");
writeFileSync(
  configPath,
  JSON.stringify({
    tasks: {
      aegis_runner: {
        templates: {
          status_console_5s: {
            args: ["--launch-status-console", "--status-console-refresh-seconds", "5"],
            description: "Launch the Aegis status console with 5-second refresh.",
          },
          daemon_confirm_post: {
            args: ["--daemon", "--confirm-post"],
            description: "Run Aegis Runner daemon with post confirmation enabled.",
          },
          daemon_confirm_post_bounded_10m: {
            args: [
              "--daemon",
              "--confirm-post",
              "--daemon-max-runtime-seconds",
              "600",
              "--daemon-poll-seconds",
              "10",
              "--daemon-heartbeat-seconds",
              "10",
            ],
            description: "Run Aegis Runner daemon for a bounded 10-minute smoke check.",
          },
          request_pause: {
            args: ["--request-pause"],
            description: "Request Aegis Runner to pause at the next safe boundary.",
          },
          resume_daemon: {
            args: ["--resume-daemon"],
            description: "Clear pause state before resuming daemon operation.",
          },
        },
      },
    },
  }),
  "utf8",
);
process.env.WORKBRIDGE_WORKSPACE_TASKS_CONFIG = configPath;
resetWorkspaceTaskConfigForTest();

const catalogWithConfig = await workspaceTaskCatalog(root);
assert.equal(catalogWithConfig[0]?.templateConfig.loaded, true);
assert.equal(catalogWithConfig[0]?.templates.length, 5);
assert.equal(catalogWithConfig[0]?.templates[0]?.name, "status_console_5s");
assert.equal(catalogWithConfig[0]?.templates[0]?.source, "config");
assert.equal(catalogWithConfig[0]?.templateConfig.issues.length, 0);

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

if (originalWorkspaceTasksConfig === undefined) {
  delete process.env.WORKBRIDGE_WORKSPACE_TASKS_CONFIG;
} else {
  process.env.WORKBRIDGE_WORKSPACE_TASKS_CONFIG = originalWorkspaceTasksConfig;
}
resetWorkspaceTaskConfigForTest();

const localRoot = mkdtempSync(join(tmpdir(), "workbridge-task-local-"));
writeFileSync(join(localRoot, "aegis_runner.py"), "print('ok')\n", "utf8");
mkdirSync(join(localRoot, ".workbridge"));
writeFileSync(
  join(localRoot, ".workbridge", "workspace-tasks.json"),
  JSON.stringify({
    tasks: {
      aegis_runner: {
        templates: {
          local_status: {
            args: ["--status"],
            description: "Run a workspace-local status check.",
          },
        },
      },
    },
  }),
  "utf8",
);

const localCatalog = await workspaceTaskCatalog(localRoot);
assert.equal(localCatalog[0]?.templateConfig.loaded, true);
assert.equal(localCatalog[0]?.templates.length, 1);
assert.equal(localCatalog[0]?.templates[0]?.name, "local_status");

const localTask = await resolveWorkspaceTask({
  workspaceRoot: localRoot,
  task: "aegis_runner",
  template: "local_status",
});
assert.deepEqual(localTask.args.slice(3), ["--status"]);
