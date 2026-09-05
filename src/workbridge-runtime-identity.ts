import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

export interface WorkbridgeRuntimeBuildIdentity {
  sourceRoot: string;
  commit?: string;
  branch?: string;
  dirty?: boolean;
}

type GitRunner = (args: string[], cwd: string) => string;

export function runtimeBuildIdentity(
  sourceRoot = defaultRuntimeSourceRoot(),
  runGit: GitRunner = defaultGitRunner,
): WorkbridgeRuntimeBuildIdentity {
  const commit = tryGit(runGit, ["rev-parse", "HEAD"], sourceRoot);
  const branch = tryGit(runGit, ["symbolic-ref", "--short", "-q", "HEAD"], sourceRoot);
  const status = tryGit(runGit, ["status", "--porcelain=v1"], sourceRoot);
  return {
    sourceRoot,
    ...(commit ? { commit } : {}),
    ...(branch ? { branch } : {}),
    ...(status !== undefined ? { dirty: status.length > 0 } : {}),
  };
}

export function defaultRuntimeSourceRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..");
}

function defaultGitRunner(args: string[], cwd: string): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    windowsHide: true,
  });
}

function tryGit(runGit: GitRunner, args: string[], cwd: string): string | undefined {
  try {
    return runGit(args, cwd).trim();
  } catch {
    return undefined;
  }
}
