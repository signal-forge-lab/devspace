import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  decodeCodexRunnerText,
  resolveCodexCliRunnerRequest,
  runCodexCliRunner,
} from "./codex-cli-runner.js";

const root = await mkdtemp(join(tmpdir(), "devspace-codex-runner-"));
const projectDir = join(root, "project");
const runnerDir = join(root, "labs", "codex_cli_runner");
const tasksDir = join(runnerDir, "tasks");
const runnerPath = join(runnerDir, "run_codex.py");

try {
  await mkdir(projectDir, { recursive: true });
  await mkdir(tasksDir, { recursive: true });
  await writeFile(runnerPath, "print('fake runner')\n", "utf8");
  await writeFile(join(projectDir, "project_task.md"), "# Project task\n", "utf8");
  await writeFile(join(tasksDir, "periodic_review.md"), "# Runner task\n", "utf8");

  const env: NodeJS.ProcessEnv = { DEVSPACE_CODEX_CLI_RUNNER: runnerPath };

  assert.equal(
    decodeCodexRunnerText(Buffer.from("\uFEFF{\"status\":\"failed\"}", "utf8")),
    "{\"status\":\"failed\"}",
  );
  assert.match(
    decodeCodexRunnerText(Buffer.from("ERROR: You've hit your usage limit.", "utf16le")),
    /usage limit/,
  );

  const projectTask = await resolveCodexCliRunnerRequest(
    {
      projectDir,
      instructionFile: "project_task.md",
      dryRun: true,
    },
    {
      allowedRoots: [root],
      env,
      cwd: root,
      pythonCommand: "python",
    },
  );
  assert.equal(projectTask.projectDir, projectDir);
  assert.equal(projectTask.instructionFile, join(projectDir, "project_task.md"));
  assert.equal(projectTask.runnerPath, runnerPath);
  assert.equal(projectTask.sandbox, "read-only");
  assert.equal(projectTask.mode, "sync");
  assert.equal(projectTask.model, "gpt-5.5");
  assert.equal(projectTask.serviceTier, "standard");
  assert.equal(projectTask.reasoningEffort, "xhigh");
  assert.equal(projectTask.earlyWaitSeconds, 10);
  assert.equal(projectTask.dryRun, true);
  assert.deepEqual(projectTask.command.slice(0, 4), [
    "python",
    runnerPath,
    projectDir,
    join(projectDir, "project_task.md"),
  ]);
  assert.deepEqual(projectTask.command.slice(6, 14), [
    "--model",
    "gpt-5.5",
    "--service-tier",
    "standard",
    "--reasoning-effort",
    "xhigh",
    "--dry-run",
  ]);
  const runnerTask = await resolveCodexCliRunnerRequest(
    {
      projectDir,
      instructionFile: "tasks/periodic_review.md",
      sandbox: "workspace-write",
    },
    {
      allowedRoots: [root],
      env,
      cwd: root,
      pythonCommand: "python",
    },
  );
  assert.equal(runnerTask.instructionFile, join(tasksDir, "periodic_review.md"));
  assert.equal(runnerTask.sandbox, "workspace-write");

  const detachedDryRun = await runCodexCliRunner(
    {
      projectDir,
      instructionFile: "project_task.md",
      mode: "detached",
      dryRun: true,
      earlyWaitSeconds: 2,
    },
    {
      allowedRoots: [root],
      env,
      cwd: root,
      pythonCommand: "python",
    },
  );
  assert.equal(detachedDryRun.status, "dry_run");
  assert.equal(detachedDryRun.model, "gpt-5.5");
  assert.equal(detachedDryRun.serviceTier, "standard");
  assert.equal(detachedDryRun.reasoningEffort, "xhigh");
  assert.match(detachedDryRun.result, /model: gpt-5\.5/);
  assert.match(detachedDryRun.result, /serviceTier: standard/);
  assert.match(detachedDryRun.result, /reasoningEffort: xhigh/);
  assert.match(detachedDryRun.stdout, /--model gpt-5\.5/);
  assert.match(detachedDryRun.stdout, /--service-tier standard/);
  assert.match(detachedDryRun.stdout, /--reasoning-effort xhigh/);
  assert.equal(detachedDryRun.mode, "detached");
  assert.equal(detachedDryRun.earlyWaitSeconds, 2);  assert.equal(detachedDryRun.jobId, undefined);
  assert.equal(detachedDryRun.launcherFile, undefined);

  await assert.rejects(
    () => resolveCodexCliRunnerRequest(
      {
        projectDir,
        instructionFile: "missing.md",
      },
      {
        allowedRoots: [root],
        env,
        cwd: root,
        pythonCommand: "python",
      },
    ),
    /instructionFile was not found/,
  );

  await writeFile(join(projectDir, "not_markdown.txt"), "no\n", "utf8");
  await assert.rejects(
    () => resolveCodexCliRunnerRequest(
      {
        projectDir,
        instructionFile: "not_markdown.txt",
      },
      {
        allowedRoots: [root],
        env,
        cwd: root,
        pythonCommand: "python",
      },
    ),
    /instructionFile must resolve to a \.md file/,
  );

  const missingPython = await runCodexCliRunner(
    {
      projectDir,
      instructionFile: "project_task.md",
      dryRun: true,
      timeout: 1,
    },
    {
      allowedRoots: [root],
      env,
      cwd: root,
      pythonCommand: "definitely-not-a-python-command",
    },
  );
  assert.equal(missingPython.exitCode, null);
  assert.equal(missingPython.errorKind, "python_not_found");
  assert.equal(missingPython.fallbackRecommended, false);
  assert.match(missingPython.stderr, /definitely-not-a-python-command|ENOENT/);

  await writeFile(
    runnerPath,
    [
      "console.log('Codex failed. ExitCode=1');",
      "console.error('usage limit reached for this Codex run');",
      "process.exit(1);",
      "",
    ].join("\\n"),
    "utf8",
  );
  const limitFailure = await runCodexCliRunner(
    {
      projectDir,
      instructionFile: "project_task.md",
      maxFallbackPromptCharacters: 1_000,
    },
    {
      allowedRoots: [root],
      env,
      cwd: root,
      pythonCommand: process.execPath,
    },
  );
  assert.equal(limitFailure.exitCode, 1);
  assert.equal(limitFailure.errorKind, "codex_limit");
  assert.equal(limitFailure.nextAction, "continue_in_chatgpt");
  assert.equal(limitFailure.fallbackRecommended, true);
  assert.equal(limitFailure.fallbackPromptSource, join(projectDir, "project_task.md"));
  assert.equal(limitFailure.fallbackPromptTruncated, false);
  assert.match(limitFailure.fallbackPrompt ?? "", /# Project task/);
  assert.match(limitFailure.result, /nextAction: continue_in_chatgpt/);
  assert.match(limitFailure.result, /Do not stop at reporting the Codex limit/);
  assert.match(limitFailure.result, /## ChatGPT fallback prompt/);
} finally {
  await rm(root, { recursive: true, force: true });
}
