import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import {
  assertWorkspaceActionExecutablesAvailable,
  RequiredExecutableMissingError,
  resolveExecutablePath,
} from "./executable-resolution.js";
import { processStep, workspaceActionSteps } from "./workspace-action-plans.js";

const root = await mkdtemp(join(tmpdir(), "workbridge-executable-resolution-test-"));
try {
  const bin = join(root, "bin");
  await mkdir(bin);
  const executableName = process.platform === "win32" ? "workbridge-fake.cmd" : "workbridge-fake";
  const executablePath = join(bin, executableName);
  await writeFile(
    executablePath,
    process.platform === "win32" ? "@echo off\r\nexit /b 0\r\n" : "#!/bin/sh\nexit 0\n",
  );
  if (process.platform !== "win32") await chmod(executablePath, 0o755);

  const env: NodeJS.ProcessEnv = process.platform === "win32"
    ? { Path: [bin].join(delimiter), PATHEXT: ".COM;.EXE;.BAT;.CMD" }
    : { PATH: [bin].join(delimiter) };
  const resolved = await resolveExecutablePath("workbridge-fake", {
    cwd: root,
    env,
  });
  assert.equal(resolved, executablePath);

  const availablePlan = workspaceActionSteps([
    processStep("fake", "Fake executable", "workbridge-fake"),
  ]);
  await assertWorkspaceActionExecutablesAvailable(availablePlan, { cwd: root, env });

  const missingPlan = workspaceActionSteps([
    processStep("missing", "Missing executable", "workbridge-definitely-missing"),
  ]);
  await assert.rejects(
    () => assertWorkspaceActionExecutablesAvailable(missingPlan, { cwd: root, env }),
    (error: unknown) => {
      assert.ok(error instanceof RequiredExecutableMissingError);
      assert.equal(error.kind, "required_executable_missing");
      assert.equal(error.executable, "workbridge-definitely-missing");
      return true;
    },
  );

  const shadowName = process.platform === "win32" ? "workbridge-shadow.cmd" : "workbridge-shadow";
  const shadowPath = join(root, shadowName);
  await writeFile(
    shadowPath,
    process.platform === "win32" ? "@echo off\r\nexit /b 0\r\n" : "#!/bin/sh\nexit 0\n",
  );
  if (process.platform !== "win32") await chmod(shadowPath, 0o755);
  assert.equal(
    await resolveExecutablePath("workbridge-shadow", {
      cwd: root,
      env: process.platform === "win32"
        ? { Path: "", PATHEXT: ".COM;.EXE;.BAT;.CMD" }
        : { PATH: "" },
    }),
    undefined,
  );
} finally {
  await rm(root, { recursive: true, force: true });
}
