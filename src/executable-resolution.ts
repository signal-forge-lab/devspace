import { constants as fsConstants } from "node:fs";
import { access, stat } from "node:fs/promises";
import {
  delimiter,
  extname,
  isAbsolute,
  join,
  resolve,
} from "node:path";
import type { WorkspaceActionExecutionPlan } from "./workspace-action-plans.js";

export interface ExecutableResolutionOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
}

export class RequiredExecutableMissingError extends Error {
  readonly kind = "required_executable_missing" as const;
  readonly executable: string;

  constructor(executable: string) {
    super(`Required executable was not found on PATH: ${executable}.`);
    this.name = "RequiredExecutableMissingError";
    this.executable = executable;
  }
}

export async function assertWorkspaceActionExecutablesAvailable(
  plan: WorkspaceActionExecutionPlan,
  options: ExecutableResolutionOptions,
): Promise<void> {
  const executables = new Set(
    plan.steps
      .filter((step) => "kind" in step && step.kind === "process")
      .map((step) => step.executable),
  );
  for (const executable of executables) {
    if (!(await resolveExecutablePath(executable, options))) {
      throw new RequiredExecutableMissingError(executable);
    }
  }
}

export async function resolveExecutablePath(
  executable: string,
  {
    cwd,
    env = process.env,
    platform = process.platform,
  }: ExecutableResolutionOptions,
): Promise<string | undefined> {
  const hasPathSeparator = executable.includes("/") || executable.includes("\\");
  if (isAbsolute(executable) || hasPathSeparator) {
    const candidate = isAbsolute(executable) ? executable : resolve(cwd, executable);
    return await executableFile(candidate, platform) ? candidate : undefined;
  }

  const searchDirectories = (environmentValue(env, "PATH", platform) ?? "")
    .split(delimiter)
    .filter(Boolean);
  const extensions = executableExtensions(executable, env, platform);
  for (const directory of searchDirectories) {
    for (const extension of extensions) {
      const candidate = join(directory, `${executable}${extension}`);
      if (await executableFile(candidate, platform)) return candidate;
    }
  }
  return undefined;
}

export function isWindowsCommandShim(path: string): boolean {
  const extension = extname(path).toLowerCase();
  return extension === ".cmd" || extension === ".bat";
}

function executableExtensions(
  executable: string,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): string[] {
  if (platform !== "win32") return [""];
  if (extname(executable)) return [""];
  const pathExt = environmentValue(env, "PATHEXT", platform) ?? ".COM;.EXE;.BAT;.CMD";
  return pathExt.split(";").filter(Boolean).map((entry) => entry.toLowerCase());
}

function environmentValue(
  env: NodeJS.ProcessEnv,
  name: string,
  platform: NodeJS.Platform,
): string | undefined {
  if (platform !== "win32") return env[name];
  const match = Object.entries(env).find(([key]) => key.toUpperCase() === name.toUpperCase());
  return match?.[1];
}

async function executableFile(path: string, platform: NodeJS.Platform): Promise<boolean> {
  try {
    const entry = await stat(path);
    if (!entry.isFile()) return false;
    await access(path, platform === "win32" ? fsConstants.F_OK : fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}
