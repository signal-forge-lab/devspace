import { homedir } from "node:os";
import { join } from "node:path";
import {
  AccessDeniedError,
  assertAllowedPath,
  isPathInsideRoot,
} from "./roots.js";

export interface WorkbridgeRootPolicyConfig {
  allowedRoots: string[];
  auxiliaryRoots: string[];
  worktreeRoot: string;
}

export function checkoutRoots(config: WorkbridgeRootPolicyConfig): string[] {
  return Array.from(new Set([...config.allowedRoots, ...config.auxiliaryRoots]));
}

export function assertCheckoutPathAllowed(
  path: string,
  config: WorkbridgeRootPolicyConfig,
): string {
  const resolved = assertAllowedPath(path, checkoutRoots(config));
  if (isPathInsideRoot(resolved, config.worktreeRoot)) {
    throw new AccessDeniedError(
      `Managed worktree paths cannot be opened in checkout mode: ${path}`,
    );
  }
  return resolved;
}

export function assertWorktreeRootInsideProjectRoots(
  worktreeRoot: string,
  projectRoots: string[],
): string {
  try {
    return assertAllowedPath(worktreeRoot, projectRoots);
  } catch (error) {
    if (error instanceof AccessDeniedError) {
      throw new Error(
        `Workbridge worktree root must be inside a project root: ${worktreeRoot}`,
      );
    }
    throw error;
  }
}

export function assertRestoredManagedWorktreePathAllowed(
  path: string,
  worktreeRoot: string,
  legacyWorktreeRoot = join(homedir(), ".devspace", "worktrees"),
): string {
  try {
    return assertAllowedPath(path, [worktreeRoot]);
  } catch (error) {
    if (!(error instanceof AccessDeniedError)) throw error;
  }
  return assertAllowedPath(path, [legacyWorktreeRoot]);
}
