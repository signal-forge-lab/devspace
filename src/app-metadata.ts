import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

interface PackageJson {
  name?: string;
  version?: string;
}

export interface AppMetadata {
  appName: string;
  displayName: string;
  legacyName: string;
  appVersion: string;
  gitCommit: string;
  gitBranch: string;
  buildSource: string;
}

export interface RuntimeInfo extends AppMetadata {
  processStartedAt: string;
  processId: number;
  nodeVersion: string;
  platform: string;
  cliEntryPath: string;
  runtimeDistPath: string;
  cwd: string;
}

const require = createRequire(import.meta.url);
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const runtimeDistPath = dirname(fileURLToPath(import.meta.url));
const processStartedAt = new Date().toISOString();
let cachedMetadata: AppMetadata | undefined;

export function getAppMetadata(): AppMetadata {
  if (cachedMetadata) return cachedMetadata;

  const packageJson = require("../package.json") as PackageJson;
  cachedMetadata = {
    appName: packageJson.name ?? "devspace",
    displayName: "Workbridge",
    legacyName: "DevSpace",
    appVersion: packageJson.version ?? "unknown",
    gitCommit: gitOutput(["rev-parse", "--short", "HEAD"]) ?? "unknown",
    gitBranch: currentGitBranch() ?? "unknown",
    buildSource: buildSource(),
  };
  return cachedMetadata;
}

export function appMetadataFields(): Record<string, string> {
  return { ...getAppMetadata() };
}

export function getRuntimeInfo(): RuntimeInfo {
  return {
    ...getAppMetadata(),
    processStartedAt,
    processId: process.pid,
    nodeVersion: process.version,
    platform: process.platform,
    cliEntryPath: process.argv[1] ?? "unknown",
    runtimeDistPath,
    cwd: process.cwd(),
  };
}

export function runtimeInfoFields(): RuntimeInfo {
  return getRuntimeInfo();
}

function currentGitBranch(): string | undefined {
  const branch = gitOutput(["branch", "--show-current"]);
  if (branch) return branch;

  const ref = gitOutput(["rev-parse", "--abbrev-ref", "HEAD"]);
  if (!ref || ref === "HEAD") return "detached";
  return ref;
}

function buildSource(): string {
  if (process.env.DEVSPACE_BUILD_SOURCE?.trim()) return process.env.DEVSPACE_BUILD_SOURCE.trim();
  if (gitOutput(["rev-parse", "--is-inside-work-tree"]) === "true") return "local-dist";
  return "package";
}

function gitOutput(args: string[]): string | undefined {
  try {
    const output = execFileSync("git", args, {
      cwd: packageRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 2000,
    }).trim();
    return output || undefined;
  } catch {
    return undefined;
  }
}
