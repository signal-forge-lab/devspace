import { spawn } from "node:child_process";
import { buildChildProcessEnvironment } from "./child-environment.js";
import {
  isWindowsCommandShim,
  RequiredExecutableMissingError,
  resolveExecutablePath,
} from "./executable-resolution.js";
import type { WorkspaceActionExecutionPlan } from "./workspace-action-plans.js";

export async function launchDetachedWorkspaceAction(input: {
  workspaceId: string;
  workspaceRoot: string;
  cwd: string;
  plan: WorkspaceActionExecutionPlan;
}): Promise<{ pid?: number }> {
  if (input.plan.steps.length !== 1 || input.plan.steps[0]?.kind !== "process") {
    throw new Error("Detached workspace actions require exactly one process step.");
  }

  const step = input.plan.steps[0];
  const env = buildChildProcessEnvironment({
    workspaceId: input.workspaceId,
    workspaceRoot: input.workspaceRoot,
  });
  const executable = await resolveExecutablePath(step.executable, { cwd: input.cwd, env });
  if (!executable) throw new RequiredExecutableMissingError(step.executable);

  const invocation = process.platform === "win32" && isWindowsCommandShim(executable)
    ? {
        executable: env.ComSpec ?? process.env.ComSpec ?? "cmd.exe",
        args: ["/d", "/c", "call", executable, ...step.args],
      }
    : { executable, args: [...step.args] };
  const child = spawn(invocation.executable, invocation.args, {
    cwd: input.cwd,
    env,
    stdio: "ignore",
    windowsHide: true,
    detached: true,
    shell: false,
  });
  await new Promise<void>((resolveSpawn, rejectSpawn) => {
    child.once("spawn", resolveSpawn);
    child.once("error", rejectSpawn);
  });
  child.unref();
  return { pid: child.pid };
}
