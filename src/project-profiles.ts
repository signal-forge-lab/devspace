import { execFile } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import {
  compileWorkspaceActionPlan,
  shellSteps,
  type WorkspaceActionExecutionPlan,
  type WorkspaceActionStep,
} from "./workspace-action-plans.js";

export const PROJECT_PROFILE_NAMES = ["workbridge", "chrome_extension", "python", "node"] as const;
export type ProjectProfileName = (typeof PROJECT_PROFILE_NAMES)[number];

export type ProjectProfileResolutionErrorKind =
  | "unsupported_project_profile"
  | "unsupported_action_for_profile"
  | "invalid_project_manifest"
  | "invalid_extension_manifest"
  | "missing_extension_resource"
  | "ambiguous_project_profile"
  | "ambiguous_python_runner"
  | "not_git_workspace"
  | "no_changed_files"
  | "no_exact_test_mapping"
  | "unsafe_changed_path"
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
  plan: WorkspaceActionExecutionPlan;
  command: string;
  displayCommand: string;
  description: string;
  policy: Array<"workspace_modify" | "long_running">;
}

export interface ChangedTestsProfileResolution extends ProjectVerifyProfileResolution {}

interface PackageManifest {
  name?: unknown;
  packageManager?: unknown;
  scripts?: unknown;
}

interface ChromeExtensionManifest {
  manifest_version?: unknown;
  icons?: unknown;
  action?: unknown;
  browser_action?: unknown;
  page_action?: unknown;
  background?: unknown;
  content_scripts?: unknown;
  options_page?: unknown;
  options_ui?: unknown;
  side_panel?: unknown;
  devtools_page?: unknown;
  chrome_url_overrides?: unknown;
}

const NODE_VERIFY_SCRIPT_ORDER = ["typecheck", "lint", "test", "build"] as const;
const execFileAsync = promisify(execFile);

type NodePackageManager = "npm" | "pnpm" | "yarn" | "bun";
type PythonRunner = "uv" | "poetry" | "system";

interface PythonProjectDetection {
  markers: string[];
  pyproject?: string;
  setupConfig?: string;
}

const PACKAGE_MANAGER_LOCKFILES: Record<NodePackageManager, readonly string[]> = {
  npm: ["package-lock.json", "npm-shrinkwrap.json"],
  pnpm: ["pnpm-lock.yaml"],
  yarn: ["yarn.lock"],
  bun: ["bun.lock", "bun.lockb"],
};

export async function resolveProjectVerifyProfile(input: {
  workspaceRoot: string;
  requestedProfile?: string;
  preset?: "quick" | "standard";
}): Promise<ProjectVerifyProfileResolution> {
  const preset = input.preset ?? "standard";
  const manifest = await readPackageManifest(input.workspaceRoot);
  const extensionManifest = await readChromeExtensionManifest(input.workspaceRoot);
  const pythonDetection = await detectPythonProject(input.workspaceRoot);
  const requestedProfile = normalizeRequestedProfile(input.requestedProfile);
  const workbridgeMatch = await matchesWorkbridgeProfile(input.workspaceRoot, manifest);

  if (requestedProfile === "workbridge") {
    if (!workbridgeMatch) {
      throw new ProjectProfileResolutionError(
        "unsupported_project_profile",
        "The workbridge project profile does not match this workspace.",
      );
    }
    return workbridgeProfile(preset);
  }

  if (requestedProfile === "node") {
    if (!manifest) {
      throw new ProjectProfileResolutionError(
        "unsupported_project_profile",
        "The node project profile requires package.json in the workspace root.",
      );
    }
    return nodeProfile(input.workspaceRoot, manifest, preset);
  }

  if (requestedProfile === "chrome_extension") {
    if (!extensionManifest) {
      throw new ProjectProfileResolutionError(
        "unsupported_project_profile",
        "The chrome_extension project profile requires manifest.json in the workspace root.",
      );
    }
    return chromeExtensionProfile(input.workspaceRoot, extensionManifest, manifest, preset);
  }

  if (requestedProfile === "python") {
    if (!pythonDetection) {
      throw new ProjectProfileResolutionError(
        "unsupported_project_profile",
        "The python project profile requires pyproject.toml, pytest.ini, setup.cfg, or requirements.txt in the workspace root.",
      );
    }
    return pythonProfile(input.workspaceRoot, pythonDetection, preset);
  }

  if (workbridgeMatch) return workbridgeProfile(preset);
  if (extensionManifest) {
    return chromeExtensionProfile(input.workspaceRoot, extensionManifest, manifest, preset);
  }
  if (pythonDetection && manifest) {
    throw new ProjectProfileResolutionError(
      "ambiguous_project_profile",
      "Both Python and Node project markers were detected. Select parameters.profile as python or node explicitly.",
    );
  }
  if (pythonDetection) return pythonProfile(input.workspaceRoot, pythonDetection, preset);
  if (manifest) return nodeProfile(input.workspaceRoot, manifest, preset);

  throw new ProjectProfileResolutionError(
    "unsupported_project_profile",
    "No supported project profile matched this workspace. Supported profiles: workbridge, chrome_extension, python, node.",
  );
}

export async function resolveChangedTestsProfile(input: {
  workspaceRoot: string;
  requestedProfile?: string;
}): Promise<ChangedTestsProfileResolution> {
  const manifest = await readPackageManifest(input.workspaceRoot);
  const extensionManifest = await readChromeExtensionManifest(input.workspaceRoot);
  const pythonDetection = await detectPythonProject(input.workspaceRoot);
  const requestedProfile = normalizeRequestedProfile(input.requestedProfile);
  const workbridgeMatch = await matchesWorkbridgeProfile(input.workspaceRoot, manifest);

  let profile: ProjectProfileName;
  if (requestedProfile) {
    if (requestedProfile === "workbridge" && !workbridgeMatch) {
      throw new ProjectProfileResolutionError(
        "unsupported_project_profile",
        "The workbridge project profile does not match this workspace.",
      );
    }
    if (requestedProfile === "python" && !pythonDetection) {
      throw new ProjectProfileResolutionError(
        "unsupported_project_profile",
        "The python project profile does not match this workspace.",
      );
    }
    if (requestedProfile === "node" && !manifest) {
      throw new ProjectProfileResolutionError(
        "unsupported_project_profile",
        "The node project profile requires package.json in the workspace root.",
      );
    }
    if (requestedProfile === "chrome_extension" && !extensionManifest) {
      throw new ProjectProfileResolutionError(
        "unsupported_project_profile",
        "The chrome_extension project profile requires manifest.json in the workspace root.",
      );
    }
    profile = requestedProfile;
  } else if (workbridgeMatch) {
    profile = "workbridge";
  } else if (extensionManifest) {
    profile = "chrome_extension";
  } else if (pythonDetection && manifest) {
    throw new ProjectProfileResolutionError(
      "ambiguous_project_profile",
      "Both Python and Node project markers were detected. Select parameters.profile as python or node explicitly.",
    );
  } else if (pythonDetection) {
    profile = "python";
  } else if (manifest) {
    profile = "node";
  } else {
    throw new ProjectProfileResolutionError(
      "unsupported_project_profile",
      "No supported project profile matched this workspace.",
    );
  }

  if (profile !== "workbridge" && profile !== "python") {
    throw new ProjectProfileResolutionError(
      "unsupported_action_for_profile",
      `The test_changed action is not available for the ${profile} profile because no exact test-runner mapping is defined.`,
    );
  }
  if (!(await isGitWorkTree(input.workspaceRoot))) {
    throw new ProjectProfileResolutionError(
      "not_git_workspace",
      "The test_changed action requires a Git working tree.",
    );
  }

  const changedFiles = await gitChangedFiles(input.workspaceRoot);
  if (changedFiles.length === 0) {
    throw new ProjectProfileResolutionError(
      "no_changed_files",
      "No staged, unstaged, or untracked files were found.",
    );
  }
  for (const path of changedFiles) assertSafeActionPath(path);

  if (profile === "workbridge") {
    const tests = await mapWorkbridgeChangedTests(input.workspaceRoot, changedFiles);
    return changedTestsResolution(profile, changedFiles, tests, (path) => `node --import tsx \"${path}\"`);
  }

  const detection = pythonDetection!;
  const configuredTools = await configuredPythonTools(input.workspaceRoot, detection);
  if (!configuredTools.has("pytest")) {
    throw new ProjectProfileResolutionError(
      "unsupported_action_for_profile",
      "The Python profile requires explicit Pytest configuration or a tests directory for test_changed.",
    );
  }
  const runner = await resolvePythonRunner(input.workspaceRoot, detection.pyproject);
  const tests = await mapPythonChangedTests(input.workspaceRoot, changedFiles);
  return changedTestsResolution(profile, changedFiles, tests, (path) => pythonPytestPathCommand(runner, path));
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

async function readChromeExtensionManifest(
  workspaceRoot: string,
): Promise<ChromeExtensionManifest | undefined> {
  const path = join(workspaceRoot, "manifest.json");
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
      throw new Error("manifest.json must contain a JSON object.");
    }
    const typed = manifest as ChromeExtensionManifest;
    if (typed.manifest_version !== 2 && typed.manifest_version !== 3) {
      throw new Error("manifest_version must be 2 or 3.");
    }
    return typed;
  } catch (error) {
    throw new ProjectProfileResolutionError(
      "invalid_extension_manifest",
      `Unable to validate manifest.json: ${error instanceof Error ? error.message : String(error)}`,
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

function workbridgeProfile(preset: "quick" | "standard"): ProjectVerifyProfileResolution {
  const steps = [
    { id: "typecheck", label: "TypeScript typecheck", command: "npm run typecheck" },
    { id: "tool-contract", label: "Tool contract baseline", command: "npm run baseline:tools:check" },
    ...(preset === "standard"
      ? [
          { id: "tests", label: "Test suite", command: "npm test" },
          { id: "build", label: "Production build", command: "npm run build" },
        ]
      : []),
    { id: "diff-check", label: "Git diff validation", command: "git diff --check" },
    { id: "status", label: "Git status", command: "git status --short" },
  ];
  const plan = shellSteps(steps);
  const command = compileWorkspaceActionPlan(plan);
  return {
    profile: "workbridge",
    confidence: "exact",
    evidence: [
      "package.json name is @waishnav/devspace",
      "src/workspace-actions.ts exists",
    ],
    plan,
    command,
    displayCommand: command,
    description: `Run the Workbridge-specific ${preset} verification sequence.`,
    policy: ["workspace_modify", "long_running"],
  };
}

async function chromeExtensionProfile(
  workspaceRoot: string,
  extensionManifest: ChromeExtensionManifest,
  packageManifest: PackageManifest | undefined,
  preset: "quick" | "standard",
): Promise<ProjectVerifyProfileResolution> {
  const referencedResources = extensionResourcePaths(extensionManifest);
  await validateExtensionResources(workspaceRoot, referencedResources);

  const steps: WorkspaceActionStep[] = [
    {
      id: "manifest",
      label: "Chrome extension manifest validation",
      command: "node -e \"const fs=require('fs');const m=JSON.parse(fs.readFileSync('manifest.json','utf8'));if(m.manifest_version!==2&&m.manifest_version!==3)throw new Error('Unsupported manifest_version');console.log('Chrome extension manifest valid')\"",
    },
  ];
  const evidence = [
    `manifest.json version: ${String(extensionManifest.manifest_version)}`,
    `validated referenced resources: ${referencedResources.length}`,
  ];

  if (packageManifest) {
    const scripts = packageScripts(packageManifest);
    const allowedScripts = preset === "quick"
      ? NODE_VERIFY_SCRIPT_ORDER.filter((name) => name !== "build")
      : NODE_VERIFY_SCRIPT_ORDER;
    const selectedScripts = allowedScripts.filter((name) => scripts.has(name));
    if (selectedScripts.length > 0) {
      const packageManager = await resolveNodePackageManager(workspaceRoot, packageManifest);
      steps.push(...selectedScripts.map((name) => ({
        id: name,
        label: `Package script: ${name}`,
        command: packageManagerRunCommand(packageManager, name),
      })));
      evidence.push(
        `package manager: ${packageManager}`,
        `supported scripts: ${selectedScripts.join(", ")}`,
      );
    }
  }

  if (await isGitWorkTree(workspaceRoot)) {
    steps.push(
      { id: "diff-check", label: "Git diff validation", command: "git diff --check" },
      { id: "status", label: "Git status", command: "git status --short" },
    );
  }

  const plan = shellSteps(steps);
  const command = compileWorkspaceActionPlan(plan);
  return {
    profile: "chrome_extension",
    confidence: "strong",
    evidence,
    plan,
    command,
    displayCommand: command,
    description: `Validate the Chrome extension and run available ${preset} package verification scripts.`,
    policy: ["workspace_modify", "long_running"],
  };
}

async function pythonProfile(
  workspaceRoot: string,
  detection: PythonProjectDetection,
  preset: "quick" | "standard",
): Promise<ProjectVerifyProfileResolution> {
  const runner = await resolvePythonRunner(workspaceRoot, detection.pyproject);
  const tools = await configuredPythonTools(workspaceRoot, detection);
  const steps: WorkspaceActionStep[] = [
    {
      id: "compileall",
      label: "Python bytecode compilation",
      command: pythonToolCommand(runner, "compileall"),
    },
  ];

  if (tools.has("ruff")) {
    steps.push({ id: "ruff", label: "Ruff lint", command: pythonToolCommand(runner, "ruff") });
  }
  if (preset === "standard" && tools.has("mypy")) {
    steps.push({ id: "mypy", label: "Mypy typecheck", command: pythonToolCommand(runner, "mypy") });
  }
  if (preset === "standard" && tools.has("pytest")) {
    steps.push({ id: "pytest", label: "Pytest suite", command: pythonToolCommand(runner, "pytest") });
  }
  if (await isGitWorkTree(workspaceRoot)) {
    steps.push(
      { id: "diff-check", label: "Git diff validation", command: "git diff --check" },
      { id: "status", label: "Git status", command: "git status --short" },
    );
  }

  const plan = shellSteps(steps);
  const command = compileWorkspaceActionPlan(plan);
  return {
    profile: "python",
    confidence: "strong",
    evidence: [
      `project markers: ${detection.markers.join(", ")}`,
      `python runner: ${runner === "system" ? systemPythonCommand() : runner}`,
      `configured tools: ${[...tools].join(", ") || "compileall only"}`,
    ],
    plan,
    command,
    displayCommand: command,
    description: `Run the Python ${preset} verification sequence with ${runner === "system" ? systemPythonCommand() : runner}.`,
    policy: ["workspace_modify", "long_running"],
  };
}

async function nodeProfile(
  workspaceRoot: string,
  manifest: PackageManifest,
  preset: "quick" | "standard",
): Promise<ProjectVerifyProfileResolution> {
  const scripts = packageScripts(manifest);
  const allowedScripts = preset === "quick"
    ? NODE_VERIFY_SCRIPT_ORDER.filter((name) => name !== "build")
    : NODE_VERIFY_SCRIPT_ORDER;
  const selectedScripts = allowedScripts.filter((name) => scripts.has(name));
  if (selectedScripts.length === 0) {
    throw new ProjectProfileResolutionError(
      "unsupported_action_for_profile",
      `The node profile found no supported ${preset} verification scripts. Expected one or more of: ${allowedScripts.join(", ")}.`,
    );
  }

  const packageManager = await resolveNodePackageManager(workspaceRoot, manifest);
  const steps: WorkspaceActionStep[] = selectedScripts.map((name) => ({
    id: name,
    label: `Package script: ${name}`,
    command: packageManagerRunCommand(packageManager, name),
  }));
  if (await isGitWorkTree(workspaceRoot)) {
    steps.push(
      { id: "diff-check", label: "Git diff validation", command: "git diff --check" },
      { id: "status", label: "Git status", command: "git status --short" },
    );
  }
  const plan = shellSteps(steps);
  const command = compileWorkspaceActionPlan(plan);
  return {
    profile: "node",
    confidence: "strong",
    evidence: [
      "package.json exists",
      `package manager: ${packageManager}`,
      `supported scripts: ${selectedScripts.join(", ")}`,
    ],
    plan,
    command,
    displayCommand: command,
    description: `Run supported package.json ${preset} verification scripts in a fixed order.`,
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

async function detectPythonProject(
  workspaceRoot: string,
): Promise<PythonProjectDetection | undefined> {
  const markerNames = ["pyproject.toml", "pytest.ini", "setup.cfg", "requirements.txt"] as const;
  const markers: string[] = [];
  for (const marker of markerNames) {
    if (await pathExists(join(workspaceRoot, marker))) markers.push(marker);
  }
  if (markers.length === 0) return undefined;
  return {
    markers,
    pyproject: markers.includes("pyproject.toml")
      ? await readFile(join(workspaceRoot, "pyproject.toml"), "utf8")
      : undefined,
    setupConfig: markers.includes("setup.cfg")
      ? await readFile(join(workspaceRoot, "setup.cfg"), "utf8")
      : undefined,
  };
}

async function resolvePythonRunner(
  workspaceRoot: string,
  pyproject: string | undefined,
): Promise<PythonRunner> {
  const uv = await pathExists(join(workspaceRoot, "uv.lock"));
  const poetry = await pathExists(join(workspaceRoot, "poetry.lock"))
    || Boolean(pyproject && /^\s*\[tool\.poetry\]\s*$/m.test(pyproject));
  if (uv && poetry) {
    throw new ProjectProfileResolutionError(
      "ambiguous_python_runner",
      "Both uv and Poetry project markers were detected. Remove the stale marker or select a single environment before verification.",
    );
  }
  if (uv) return "uv";
  if (poetry) return "poetry";
  return "system";
}

async function configuredPythonTools(
  workspaceRoot: string,
  detection: PythonProjectDetection,
): Promise<Set<"ruff" | "mypy" | "pytest">> {
  const tools = new Set<"ruff" | "mypy" | "pytest">();
  const pyproject = detection.pyproject ?? "";
  const setupConfig = detection.setupConfig ?? "";

  if (
    await anyPathExists([
      join(workspaceRoot, "ruff.toml"),
      join(workspaceRoot, ".ruff.toml"),
    ])
    || /^\s*\[tool\.ruff(?:\.|\])/m.test(pyproject)
  ) {
    tools.add("ruff");
  }
  if (
    await anyPathExists([
      join(workspaceRoot, "mypy.ini"),
      join(workspaceRoot, ".mypy.ini"),
    ])
    || /^\s*\[tool\.mypy\]\s*$/m.test(pyproject)
    || /^\s*\[mypy\]\s*$/m.test(setupConfig)
  ) {
    tools.add("mypy");
  }
  if (
    detection.markers.includes("pytest.ini")
    || /^\s*\[tool\.pytest(?:\.|\])/m.test(pyproject)
    || /^\s*\[tool:pytest\]\s*$/m.test(setupConfig)
    || await pathExists(join(workspaceRoot, "tests"))
  ) {
    tools.add("pytest");
  }
  return tools;
}

function pythonToolCommand(
  runner: PythonRunner,
  tool: "compileall" | "ruff" | "mypy" | "pytest",
): string {
  if (runner === "uv") {
    if (tool === "compileall") return "uv run python -m compileall -q .";
    if (tool === "ruff") return "uv run ruff check .";
    if (tool === "mypy") return "uv run mypy .";
    return "uv run pytest";
  }
  if (runner === "poetry") {
    if (tool === "compileall") return "poetry run python -m compileall -q .";
    if (tool === "ruff") return "poetry run ruff check .";
    if (tool === "mypy") return "poetry run mypy .";
    return "poetry run pytest";
  }

  const python = systemPythonCommand();
  if (tool === "compileall") return `${python} -m compileall -q .`;
  if (tool === "ruff") return `${python} -m ruff check .`;
  if (tool === "mypy") return `${python} -m mypy .`;
  return `${python} -m pytest`;
}

function systemPythonCommand(): "py" | "python3" {
  return process.platform === "win32" ? "py" : "python3";
}

async function gitChangedFiles(workspaceRoot: string): Promise<string[]> {
  const commands = [
    ["diff", "--name-only", "--diff-filter=ACMR"],
    ["diff", "--cached", "--name-only", "--diff-filter=ACMR"],
    ["ls-files", "--others", "--exclude-standard"],
  ] as const;
  const changed = new Set<string>();
  for (const args of commands) {
    const { stdout } = await execFileAsync("git", ["-C", workspaceRoot, ...args], { windowsHide: true });
    for (const line of stdout.split(/\r?\n/)) {
      const path = line.trim().replaceAll("\\", "/");
      if (path) changed.add(path);
    }
  }
  return [...changed].sort();
}

async function mapWorkbridgeChangedTests(
  workspaceRoot: string,
  changedFiles: readonly string[],
): Promise<string[]> {
  const tests = new Set<string>();
  for (const path of changedFiles) {
    if (/\.(?:test|spec)\.[jt]sx?$/.test(path) && await pathExists(join(workspaceRoot, path))) {
      tests.add(path);
      continue;
    }
    const match = /^(.*)\.([jt]sx?)$/.exec(path);
    if (!match || !path.startsWith("src/")) continue;
    const base = match[1];
    const extension = match[2];
    for (const candidate of [`${base}.test.${extension}`, `${base}.spec.${extension}`]) {
      if (await pathExists(join(workspaceRoot, candidate))) tests.add(candidate);
    }
  }
  return requireExactTestMappings(tests);
}

async function mapPythonChangedTests(
  workspaceRoot: string,
  changedFiles: readonly string[],
): Promise<string[]> {
  const tests = new Set<string>();
  for (const path of changedFiles) {
    if (!path.endsWith(".py")) continue;
    const parts = path.split("/");
    const file = parts.at(-1)!;
    if ((file.startsWith("test_") || file.endsWith("_test.py")) && await pathExists(join(workspaceRoot, path))) {
      tests.add(path);
      continue;
    }
    if (file === "__init__.py") continue;
    const stem = file.slice(0, -3);
    const directory = parts.slice(0, -1).join("/");
    const candidates = [
      directory ? `${directory}/test_${stem}.py` : `test_${stem}.py`,
      directory ? `${directory}/${stem}_test.py` : `${stem}_test.py`,
      `tests/test_${stem}.py`,
      directory ? `tests/${directory}/test_${stem}.py` : `tests/test_${stem}.py`,
    ];
    for (const candidate of candidates) {
      if (await pathExists(join(workspaceRoot, candidate))) tests.add(candidate);
    }
  }
  return requireExactTestMappings(tests);
}

function requireExactTestMappings(tests: Set<string>): string[] {
  const result = [...tests].sort();
  if (result.length === 0) {
    throw new ProjectProfileResolutionError(
      "no_exact_test_mapping",
      "No exact changed-file to test-file mapping was found. Run project_verify/quick instead.",
    );
  }
  return result;
}

function changedTestsResolution(
  profile: "workbridge" | "python",
  changedFiles: readonly string[],
  tests: readonly string[],
  commandForPath: (path: string) => string,
): ChangedTestsProfileResolution {
  const steps = tests.map((path, index) => ({
    id: `test-${index + 1}`,
    label: `Changed-file test: ${path}`,
    command: commandForPath(path),
  }));
  const plan = shellSteps(steps);
  const command = compileWorkspaceActionPlan(plan);
  return {
    profile,
    confidence: "exact",
    evidence: [
      `changed files: ${changedFiles.join(", ")}`,
      `mapped tests: ${tests.join(", ")}`,
    ],
    plan,
    command,
    displayCommand: command,
    description: "Run tests with exact mappings from the current Git changes.",
    policy: ["workspace_modify", "long_running"],
  };
}

function pythonPytestPathCommand(runner: PythonRunner, path: string): string {
  if (runner === "uv") return `uv run pytest \"${path}\"`;
  if (runner === "poetry") return `poetry run pytest \"${path}\"`;
  return `${systemPythonCommand()} -m pytest \"${path}\"`;
}

function assertSafeActionPath(path: string): void {
  if (!/^[A-Za-z0-9_./-]+$/.test(path) || path.startsWith("/") || path.includes("../")) {
    throw new ProjectProfileResolutionError(
      "unsafe_changed_path",
      `Changed path cannot be represented safely in a fixed action command: ${path}`,
    );
  }
}

function extensionResourcePaths(manifest: ChromeExtensionManifest): string[] {
  const paths = new Set<string>();
  addStringRecordValues(paths, manifest.icons);
  addActionResources(paths, manifest.action);
  addActionResources(paths, manifest.browser_action);
  addActionResources(paths, manifest.page_action);

  const background = objectRecord(manifest.background);
  addString(paths, background?.service_worker);
  addStringArray(paths, background?.scripts);

  if (Array.isArray(manifest.content_scripts)) {
    for (const entry of manifest.content_scripts) {
      const contentScript = objectRecord(entry);
      addStringArray(paths, contentScript?.js);
      addStringArray(paths, contentScript?.css);
    }
  }

  addString(paths, manifest.options_page);
  addString(paths, objectRecord(manifest.options_ui)?.page);
  addString(paths, objectRecord(manifest.side_panel)?.default_path);
  addString(paths, manifest.devtools_page);
  addStringRecordValues(paths, manifest.chrome_url_overrides);
  return [...paths];
}

function addActionResources(paths: Set<string>, value: unknown): void {
  const action = objectRecord(value);
  if (!action) return;
  addString(paths, action.default_popup);
  if (typeof action.default_icon === "string") addString(paths, action.default_icon);
  else addStringRecordValues(paths, action.default_icon);
}

function addStringRecordValues(paths: Set<string>, value: unknown): void {
  const record = objectRecord(value);
  if (!record) return;
  for (const candidate of Object.values(record)) addString(paths, candidate);
}

function addStringArray(paths: Set<string>, value: unknown): void {
  if (!Array.isArray(value)) return;
  for (const candidate of value) addString(paths, candidate);
}

function addString(paths: Set<string>, value: unknown): void {
  if (typeof value !== "string" || value.trim() === "") return;
  paths.add(value.trim());
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

async function validateExtensionResources(
  workspaceRoot: string,
  resources: readonly string[],
): Promise<void> {
  const missing: string[] = [];
  for (const resource of resources) {
    const relativePath = normalizeExtensionResourcePath(resource);
    if (!relativePath) continue;
    const absolutePath = resolve(workspaceRoot, relativePath);
    const relation = relative(workspaceRoot, absolutePath);
    if (relation === ".." || relation.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(relation)) {
      throw new ProjectProfileResolutionError(
        "invalid_extension_manifest",
        `Extension resource escapes the workspace root: ${resource}`,
      );
    }
    if (!(await pathExists(absolutePath))) missing.push(resource);
  }

  if (missing.length > 0) {
    throw new ProjectProfileResolutionError(
      "missing_extension_resource",
      `Chrome extension manifest references missing resources: ${missing.join(", ")}.`,
    );
  }
}

function normalizeExtensionResourcePath(resource: string): string | undefined {
  if (/^[a-z][a-z0-9+.-]*:/i.test(resource) || resource.startsWith("//")) {
    return undefined;
  }
  const withoutSuffix = resource.split(/[?#]/, 1)[0]?.replace(/^\/+/, "").trim();
  if (!withoutSuffix || withoutSuffix.includes("*")) return undefined;
  if (isAbsolute(withoutSuffix)) {
    throw new ProjectProfileResolutionError(
      "invalid_extension_manifest",
      `Extension resource must be relative: ${resource}`,
    );
  }
  return withoutSuffix;
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
