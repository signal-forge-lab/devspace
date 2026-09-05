import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { isAbsolute, join, normalize, posix, win32 } from "node:path";
import {
  processStep,
  workspaceActionSteps,
  type WorkspaceActionExecutionPlan,
} from "./workspace-action-plans.js";

export const GRAFT_ACTIONS = ["map", "ask", "callers", "skeleton", "grep", "check"] as const;
export type GraftAction = (typeof GRAFT_ACTIONS)[number];

export interface GraftActionParameters {
  query?: string;
  symbol?: string;
  file?: string;
  pattern?: string;
  scopePath?: string;
  limit?: number;
  direction?: "in" | "out";
  depth?: number | "all";
  ignoreCase?: boolean;
  fixed?: boolean;
  maxDirs?: number;
}

export interface GraftActionPlan {
  graphDir: string;
  plan: WorkspaceActionExecutionPlan;
}

const GRAFT_PACKAGE = "@nanonets/graft@0.10.1";

export function graftGraphDir(stateDir: string, workspaceRoot: string): string {
  const token = createHash("sha256").update(workspaceRoot).digest("hex").slice(0, 24);
  return join(stateDir, "graft", token);
}

export function graftGraphReady(graphDir: string): boolean {
  return existsSync(join(graphDir, ".graph", "wiring.json"));
}

export function createGraftActionPlan({
  action,
  parameters = {},
  workspaceRoot,
  stateDir,
  graphReady = graftGraphReady(graftGraphDir(stateDir, workspaceRoot)),
}: {
  action: GraftAction;
  parameters?: GraftActionParameters;
  workspaceRoot: string;
  stateDir: string;
  graphReady?: boolean;
}): GraftActionPlan {
  const graphDir = graftGraphDir(stateDir, workspaceRoot);
  const executable = process.platform === "win32" ? "npx.cmd" : "npx";
  const baseArgs = ["-y", GRAFT_PACKAGE, "--dir", graphDir];
  const steps = [];

  if (action !== "check" && !graphReady) {
    steps.push(processStep(
      "graft-build",
      "Build Graft wiring graph",
      executable,
      [...baseArgs, "build", workspaceRoot],
    ));
  }

  steps.push(processStep(
    `graft-${action}`,
    `Run Graft ${action}`,
    executable,
    [...baseArgs, ...graftActionArgs(action, parameters, workspaceRoot)],
  ));

  return { graphDir, plan: workspaceActionSteps(steps) };
}

function graftActionArgs(
  action: GraftAction,
  parameters: GraftActionParameters,
  workspaceRoot: string,
): string[] {
  const scopePath = parameters.scopePath === undefined
    ? undefined
    : repoRelativePath(parameters.scopePath, "scopePath");

  if (action === "map") {
    const args = ["map", workspaceRoot, "--json"];
    if (parameters.maxDirs !== undefined) args.push("--max-dirs", String(parameters.maxDirs));
    return args;
  }

  if (action === "ask") {
    const args = ["ask", requiredText(parameters.query, "query"), workspaceRoot, "--json"];
    if (parameters.limit !== undefined) args.push("--limit", String(parameters.limit));
    if (scopePath) args.push("--in", scopePath);
    return args;
  }

  if (action === "callers") {
    const args = ["callers", requiredText(parameters.symbol, "symbol"), workspaceRoot, "--json"];
    if (parameters.direction) args.push("--direction", parameters.direction);
    if (parameters.depth !== undefined) args.push("--depth", String(parameters.depth));
    if (scopePath) args.push("--in", scopePath);
    return args;
  }

  if (action === "skeleton") {
    return [
      "skeleton",
      repoRelativePath(requiredText(parameters.file, "file"), "file"),
      workspaceRoot,
      "--json",
    ];
  }

  if (action === "grep") {
    const args = ["grep", requiredText(parameters.pattern, "pattern"), workspaceRoot, "--json"];
    if (parameters.ignoreCase) args.push("--ignore-case");
    if (parameters.fixed) args.push("--fixed");
    if (scopePath) args.push("--in", scopePath);
    return args;
  }

  return ["check", workspaceRoot, "--json"];
}

function requiredText(value: string | undefined, field: string): string {
  const normalized = value?.trim();
  if (!normalized) throw new Error(`Graft ${field} must be a non-empty string.`);
  return normalized;
}

function repoRelativePath(value: string, field: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`Graft ${field} must be a non-empty workspace-relative path.`);
  if (isAbsolute(trimmed) || win32.isAbsolute(trimmed) || posix.isAbsolute(trimmed)) {
    throw new Error(`Graft ${field} must be workspace-relative.`);
  }
  const normalized = normalize(trimmed).replaceAll("\\", "/");
  if (normalized === ".." || normalized.startsWith("../")) {
    throw new Error(`Graft ${field} must stay inside the workspace.`);
  }
  return normalized.replace(/^\.\//, "");
}
