import { execFile } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

export const PROJECT_PROFILE_NAMES = ["workbridge", "node"] as const;
export type ProjectProfileName = (typeof PROJECT_PROFILE_NAMES)[number];

export type ProjectProfileResolutionErrorKind =
  | "unsupported_project_profile"
  | "unsupported_action_for_profile"
  | "invalid_project_manifest"
  | "unsupported_package_manager"
  | "ambiguous_package_manager";

export class ProjectProfileResolutionError extends Error {
  readonly kind: ProjectProfileResolutionErrorKind;

  constructor(kind: ProjectProfileResolutionErrorKind, message: string) {
    super(message);
    this.name = "ProjectProfileResolutionError";
    this.kind = kind;
  }
}

export interface ProjectVerifyProfileResolution {
  profile: ProjectProfileName;
  confidence: "exact" | "strong";
  evidence: string[];
  command: string;
  displayCommand: string;
  description: string;
  policy: Array<"workspace_modify" | "long_running">;
}

interface PackageManifest {
  name?: unknown;
  packageManager?: unknown;
  scripts?: unknown;
}

const NODE_VERIFY_SCRIPT_ORDER = ["typecheck", "lint", "test", "build"] as const;
const execFileAsync = promisify(execFile);

type NodePackageManager = "npm" | "pnpm" | "yarn" | "bun";

const PACKAGE_MANAGER_LOCKFILES: Record<NodePackageManager, readonly string[]> = {
  npm: ["package-lock.json", "npm-shrinkwrap.json"],
  pnpm: ["pnpm-lock.yaml"],
  yarn: ["yarn.lock"],
  bun: ["bun.lock", "bun.lockb"],
};

export async function resolveProjectVerifyProfile(input: {
  workspaceRoot: string;
  requestedProfile?: string;
}): Promise<ProjectVerifyProfileResolution> {
  const manifest = await readPackageManifest(input.workspaceRoot);
  const requestedProfile = normalizeRequestedProfile(input.requestedProfile);
  const workbridgeMatch = await matchesWorkbridgeProfile(input.workspaceRoot, manifest);

  if (requestedProfile === "workbridge") {
    if (!workbridgeMatch) {
      throw new ProjectProfileResolutionError(
        "unsupported_project_profile",
        "The workbridge project profile does not match this workspace.",
      );
    }
    return workbridgeProfile();
  }

  if (requestedProfile === "node") {
    if (!manifest) {
      throw new ProjectProfileResolutionError(
        "unsupported_project_profile",
        "The node project profile requires package.json in the workspace root.",
      );
    }
    return nodeProfile(input.workspaceRoot, manifest);
  }

  if (workbridgeMatch) return workbridgeProfile();
  if (manifest) return nodeProfile(input.workspaceRoot, manifest);

  throw new ProjectProfileResolutionError(
    "unsupported_project_profile",
    "No supported project profile matched this workspace. Supported profiles: workbridge, node.",
  );
}

function normalizeRequestedProfile(value: string | undefined): ProjectProfileName | undefined {
  const profile = value?.trim();
  if (!profile) return undefined;
  if ((PROJECT_PROFILE_NAMES as readonly string[]).includes(profile)) {
    return profile as ProjectProfileName;
  }
  throw new ProjectProfileResolutionError(
    "unsupported_project_profile",
    `Unsupported project profile: ${profile}. Supported profiles: ${PROJECT_PROFILE_NAMES.join(", ")}.`,
  );
}

async function readPackageManifest(workspaceRoot: string): Promise<PackageManifest | undefined> {
  const path = join(workspaceRoot, "package.json");
  let source: string;
  try {
    source = await readFile(path, "utf8");
  } catch (error) {
    if (errorCode(error) === "ENOENT") return undefined;
    throw error;
  }

  try {
    const manifest = JSON.parse(source) as unknown;
    if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
      throw new Error("package.json must contain a JSON object.");
    }
    return manifest as PackageManifest;
  } catch (error) {
    throw new ProjectProfileResolutionError(
      "invalid_project_manifest",
      `Unable to parse package.json: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function matchesWorkbridgeProfile(
  workspaceRoot: string,
  manifest: PackageManifest | undefined,
): Promise<boolean> {
  if (manifest?.name !== "@waishnav/devspace") return false;
  return pathExists(join(workspaceRoot, "src", "workspace-actions.ts"));
}

function workbridgeProfile(): ProjectVerifyProfileResolution {
  const commands = [
    "npm run typecheck",
    "npm run baseline:tools:check",
    "npm test",
    "npm run build",
    "git diff --check",
    "git status --short",
  ];
  const command = commands.join(" && ");
  return {
    profile: "workbridge",
    confidence: "exact",
    evidence: [
      "package.json name is @waishnav/devspace",
      "src/workspace-actions.ts exists",
    ],
    command,
    displayCommand: command,
    description: "Run the Workbridge-specific verification sequence.",
    policy: ["workspace_modify", "long_running"],
  };
}

async function nodeProfile(
  workspaceRoot: string,
  manifest: PackageManifest,
): Promise<ProjectVerifyProfileResolution> {
  const scripts = packageScripts(manifest);
  const selectedScripts = NODE_VERIFY_SCRIPT_ORDER.filter((name) => scripts.has(name));
  if (selectedScripts.length === 0) {
    throw new ProjectProfileResolutionError(
      "unsupported_action_for_profile",
      "The node profile found no supported verification scripts. Expected one or more of: typecheck, lint, test, build.",
    );
  }

  const packageManager = await resolveNodePackageManager(workspaceRoot, manifest);
  const commands = selectedScripts.map((name) => packageManagerRunCommand(packageManager, name));
  if (await isGitWorkTree(workspaceRoot)) {
    commands.push("git diff --check", "git status --short");
  }
  const command = commands.join(" && ");
  return {
    profile: "node",
    confidence: "strong",
    evidence: [
      "package.json exists",
      `package manager: ${packageManager}`,
      `supported scripts: ${selectedScripts.join(", ")}`,
    ],
    command,
    displayCommand: command,
    description: "Run supported package.json verification scripts in a fixed order.",
    policy: ["workspace_modify", "long_running"],
  };
}

async function resolveNodePackageManager(
  workspaceRoot: string,
  manifest: PackageManifest,
): Promise<NodePackageManager> {
  const declared = declaredPackageManager(manifest.packageManager);
  if (declared) return declared;

  const detected: NodePackageManager[] = [];
  for (const manager of Object.keys(PACKAGE_MANAGER_LOCKFILES) as NodePackageManager[]) {
    const lockfiles = PACKAGE_MANAGER_LOCKFILES[manager];
    if (await anyPathExists(lockfiles.map((file) => join(workspaceRoot, file)))) {
      detected.push(manager);
    }
  }

  if (detected.length > 1) {
    throw new ProjectProfileResolutionError(
      "ambiguous_package_manager",
      `Multiple package managers were detected from lockfiles: ${detected.join(", ")}. Declare packageManager in package.json to choose one explicitly.`,
    );
  }
  return detected[0] ?? "npm";
}

function declaredPackageManager(value: unknown): NodePackageManager | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim() === "") {
    throw new ProjectProfileResolutionError(
      "invalid_project_manifest",
      "package.json packageManager must be a non-empty string when present.",
    );
  }

  const name = value.trim().split("@")[0]?.toLowerCase();
  if (name === "npm" || name === "pnpm" || name === "yarn" || name === "bun") {
    return name;
  }
  throw new ProjectProfileResolutionError(
    "unsupported_package_manager",
    `Unsupported package manager in package.json: ${value}. Supported package managers: npm, pnpm, yarn, bun.`,
  );
}

function packageManagerRunCommand(manager: NodePackageManager, script: string): string {
  return `${manager} run ${script}`;
}

async function isGitWorkTree(workspaceRoot: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["-C", workspaceRoot, "rev-parse", "--is-inside-work-tree"],
      { windowsHide: true },
    );
    return stdout.trim() === "true";
  } catch {
    return false;
  }
}

function packageScripts(manifest: PackageManifest): Set<string> {
  if (!manifest.scripts || typeof manifest.scripts !== "object" || Array.isArray(manifest.scripts)) {
    return new Set();
  }
  return new Set(
    Object.entries(manifest.scripts)
      .filter(([, command]) => typeof command === "string" && command.trim() !== "")
      .map(([name]) => name),
  );
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error) {
    if (errorCode(error) === "ENOENT") return false;
    throw error;
  }
}

async function anyPathExists(paths: readonly string[]): Promise<boolean> {
  for (const path of paths) {
    if (await pathExists(path)) return true;
  }
  return false;
}

function errorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}
