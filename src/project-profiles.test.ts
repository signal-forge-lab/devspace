import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  ProjectProfileResolutionError,
  resolveChangedTestsProfile,
  resolveProjectVerifyProfile,
} from "./project-profiles.js";

const execFileAsync = promisify(execFile);

const root = await mkdtemp(join(tmpdir(), "workbridge-project-profiles-test-"));
try {
  const workbridgeRoot = join(root, "workbridge");
  await mkdir(join(workbridgeRoot, "src"), { recursive: true });
  await writeFile(
    join(workbridgeRoot, "package.json"),
    JSON.stringify({ name: "@waishnav/devspace", scripts: { test: "node test.js" } }),
  );
  await writeFile(join(workbridgeRoot, "src", "workspace-actions.ts"), "export {};\n");

  const workbridge = await resolveProjectVerifyProfile({ workspaceRoot: workbridgeRoot });
  assert.equal(workbridge.profile, "workbridge");
  assert.equal(workbridge.confidence, "exact");
  assert.match(workbridge.command, /npm run baseline:tools:check/);
  assert.deepEqual(workbridge.policy, ["workspace_modify", "long_running"]);

  const forcedNode = await resolveProjectVerifyProfile({
    workspaceRoot: workbridgeRoot,
    requestedProfile: "node",
  });
  assert.equal(forcedNode.profile, "node");
  assert.equal(forcedNode.command, "npm run test");

  const nodeRoot = join(root, "node");
  await mkdir(nodeRoot, { recursive: true });
  await execFileAsync("git", ["init", nodeRoot], { windowsHide: true });
  await writeFile(
    join(nodeRoot, "package.json"),
    JSON.stringify({
      name: "example-node-project",
      scripts: {
        build: "node build.js",
        test: "node test.js",
        custom: "node custom.js",
        typecheck: "tsc --noEmit",
      },
    }),
  );
  const node = await resolveProjectVerifyProfile({ workspaceRoot: nodeRoot });
  assert.equal(node.profile, "node");
  assert.equal(
    node.command,
    "npm run typecheck && npm run test && npm run build && git diff --check && git status --short",
  );
  assert.match(node.evidence.join("\n"), /package manager: npm/);

  const nodeQuick = await resolveProjectVerifyProfile({
    workspaceRoot: nodeRoot,
    preset: "quick",
  });
  assert.equal(
    nodeQuick.command,
    "npm run typecheck && npm run test && git diff --check && git status --short",
  );
  assert.doesNotMatch(nodeQuick.command, /npm run build/);

  const chromeRoot = join(root, "chrome-extension");
  await mkdir(join(chromeRoot, "scripts"), { recursive: true });
  await mkdir(join(chromeRoot, "styles"), { recursive: true });
  await mkdir(join(chromeRoot, "icons"), { recursive: true });
  await mkdir(join(chromeRoot, "pages"), { recursive: true });
  await writeFile(
    join(chromeRoot, "manifest.json"),
    JSON.stringify({
      manifest_version: 3,
      name: "Example extension",
      version: "1.0.0",
      background: { service_worker: "scripts/background.js" },
      content_scripts: [{
        matches: ["https://example.com/*"],
        js: ["scripts/content.js"],
        css: ["styles/content.css"],
      }],
      action: {
        default_popup: "pages/popup.html",
        default_icon: { 16: "icons/icon-16.png" },
      },
      icons: { 48: "icons/icon-48.png" },
      options_page: "pages/options.html",
    }),
  );
  await writeFile(
    join(chromeRoot, "package.json"),
    JSON.stringify({ scripts: { test: "node test.js", build: "vite build" } }),
  );
  await Promise.all([
    writeFile(join(chromeRoot, "scripts", "background.js"), "\n"),
    writeFile(join(chromeRoot, "scripts", "content.js"), "\n"),
    writeFile(join(chromeRoot, "styles", "content.css"), "\n"),
    writeFile(join(chromeRoot, "icons", "icon-16.png"), "\n"),
    writeFile(join(chromeRoot, "icons", "icon-48.png"), "\n"),
    writeFile(join(chromeRoot, "pages", "popup.html"), "\n"),
    writeFile(join(chromeRoot, "pages", "options.html"), "\n"),
  ]);
  const chrome = await resolveProjectVerifyProfile({ workspaceRoot: chromeRoot });
  assert.equal(chrome.profile, "chrome_extension");
  assert.match(chrome.command, /Chrome extension manifest valid/);
  assert.match(chrome.command, /npm run test/);
  assert.match(chrome.command, /npm run build/);
  assert.match(chrome.evidence.join("\n"), /validated referenced resources: 7/);

  const chromeQuick = await resolveProjectVerifyProfile({
    workspaceRoot: chromeRoot,
    preset: "quick",
  });
  assert.equal(chromeQuick.profile, "chrome_extension");
  assert.match(chromeQuick.command, /npm run test/);
  assert.doesNotMatch(chromeQuick.command, /npm run build/);

  const missingChromeRoot = join(root, "chrome-missing-resource");
  await mkdir(missingChromeRoot, { recursive: true });
  await writeFile(
    join(missingChromeRoot, "manifest.json"),
    JSON.stringify({
      manifest_version: 3,
      name: "Missing resource",
      version: "1.0.0",
      background: { service_worker: "missing.js" },
    }),
  );
  await assert.rejects(
    () => resolveProjectVerifyProfile({ workspaceRoot: missingChromeRoot }),
    (error: unknown) => {
      assert.ok(error instanceof ProjectProfileResolutionError);
      assert.equal(error.kind, "missing_extension_resource");
      return true;
    },
  );

  const invalidChromeRoot = join(root, "chrome-invalid-manifest");
  await mkdir(invalidChromeRoot, { recursive: true });
  await writeFile(
    join(invalidChromeRoot, "manifest.json"),
    JSON.stringify({ manifest_version: 1, name: "Invalid", version: "1.0.0" }),
  );
  await assert.rejects(
    () => resolveProjectVerifyProfile({ workspaceRoot: invalidChromeRoot }),
    (error: unknown) => {
      assert.ok(error instanceof ProjectProfileResolutionError);
      assert.equal(error.kind, "invalid_extension_manifest");
      return true;
    },
  );

  const pythonUvRoot = join(root, "python-uv");
  await mkdir(join(pythonUvRoot, "tests"), { recursive: true });
  await writeFile(
    join(pythonUvRoot, "pyproject.toml"),
    [
      "[project]",
      "name = \"example-python\"",
      "version = \"0.1.0\"",
      "",
      "[tool.ruff]",
      "line-length = 100",
      "",
      "[tool.mypy]",
      "python_version = \"3.12\"",
      "",
      "[tool.pytest.ini_options]",
      "testpaths = [\"tests\"]",
    ].join("\n"),
  );
  await writeFile(join(pythonUvRoot, "uv.lock"), "version = 1\n");
  const pythonUv = await resolveProjectVerifyProfile({ workspaceRoot: pythonUvRoot });
  assert.equal(pythonUv.profile, "python");
  assert.equal(
    pythonUv.command,
    "uv run python -m compileall -q . && uv run ruff check . && uv run mypy . && uv run pytest",
  );
  assert.match(pythonUv.evidence.join("\n"), /python runner: uv/);

  const pythonUvQuick = await resolveProjectVerifyProfile({
    workspaceRoot: pythonUvRoot,
    preset: "quick",
  });
  assert.equal(
    pythonUvQuick.command,
    "uv run python -m compileall -q . && uv run ruff check .",
  );

  const pythonPoetryRoot = join(root, "python-poetry");
  await mkdir(pythonPoetryRoot, { recursive: true });
  await writeFile(
    join(pythonPoetryRoot, "pyproject.toml"),
    "[tool.poetry]\nname = \"poetry-project\"\nversion = \"0.1.0\"\n",
  );
  await writeFile(join(pythonPoetryRoot, "poetry.lock"), "# poetry lock\n");
  const pythonPoetry = await resolveProjectVerifyProfile({ workspaceRoot: pythonPoetryRoot });
  assert.equal(pythonPoetry.profile, "python");
  assert.equal(pythonPoetry.command, "poetry run python -m compileall -q .");

  const pythonSystemRoot = join(root, "python-system");
  await mkdir(pythonSystemRoot, { recursive: true });
  await writeFile(join(pythonSystemRoot, "requirements.txt"), "requests\n");
  const pythonSystem = await resolveProjectVerifyProfile({ workspaceRoot: pythonSystemRoot });
  assert.equal(pythonSystem.profile, "python");
  assert.match(pythonSystem.command, /^(py|python3) -m compileall -q \.$/);

  const ambiguousPythonRoot = join(root, "python-ambiguous-runner");
  await mkdir(ambiguousPythonRoot, { recursive: true });
  await writeFile(
    join(ambiguousPythonRoot, "pyproject.toml"),
    "[tool.poetry]\nname = \"ambiguous\"\nversion = \"0.1.0\"\n",
  );
  await writeFile(join(ambiguousPythonRoot, "uv.lock"), "version = 1\n");
  await assert.rejects(
    () => resolveProjectVerifyProfile({ workspaceRoot: ambiguousPythonRoot }),
    (error: unknown) => {
      assert.ok(error instanceof ProjectProfileResolutionError);
      assert.equal(error.kind, "ambiguous_python_runner");
      return true;
    },
  );

  const mixedRoot = join(root, "mixed-node-python");
  await mkdir(mixedRoot, { recursive: true });
  await writeFile(join(mixedRoot, "pyproject.toml"), "[project]\nname = \"mixed\"\n");
  await writeFile(
    join(mixedRoot, "package.json"),
    JSON.stringify({ scripts: { test: "node test.js" } }),
  );
  await assert.rejects(
    () => resolveProjectVerifyProfile({ workspaceRoot: mixedRoot }),
    (error: unknown) => {
      assert.ok(error instanceof ProjectProfileResolutionError);
      assert.equal(error.kind, "ambiguous_project_profile");
      return true;
    },
  );
  const mixedNode = await resolveProjectVerifyProfile({
    workspaceRoot: mixedRoot,
    requestedProfile: "node",
  });
  assert.equal(mixedNode.profile, "node");
  const mixedPython = await resolveProjectVerifyProfile({
    workspaceRoot: mixedRoot,
    requestedProfile: "python",
  });
  assert.equal(mixedPython.profile, "python");

  const changedWorkbridgeRoot = join(root, "changed-workbridge");
  await mkdir(join(changedWorkbridgeRoot, "src"), { recursive: true });
  await writeFile(
    join(changedWorkbridgeRoot, "package.json"),
    JSON.stringify({ name: "@waishnav/devspace", scripts: { test: "node test.js" } }),
  );
  await writeFile(join(changedWorkbridgeRoot, "src", "workspace-actions.ts"), "export {};\n");
  await writeFile(join(changedWorkbridgeRoot, "src", "sample.ts"), "export const value = 1;\n");
  await writeFile(join(changedWorkbridgeRoot, "src", "sample.test.ts"), "export {};\n");
  await initializeGitRepository(changedWorkbridgeRoot);
  await writeFile(join(changedWorkbridgeRoot, "src", "sample.ts"), "export const value = 2;\n");
  const changedWorkbridge = await resolveChangedTestsProfile({ workspaceRoot: changedWorkbridgeRoot });
  assert.equal(changedWorkbridge.profile, "workbridge");
  assert.equal(changedWorkbridge.command, "node --import tsx \"src/sample.test.ts\"");

  const changedPythonRoot = join(root, "changed-python");
  await mkdir(join(changedPythonRoot, "tests"), { recursive: true });
  await writeFile(
    join(changedPythonRoot, "pyproject.toml"),
    "[project]\nname = \"changed-python\"\n[tool.pytest.ini_options]\ntestpaths = [\"tests\"]\n",
  );
  await writeFile(join(changedPythonRoot, "uv.lock"), "version = 1\n");
  await writeFile(join(changedPythonRoot, "alpha.py"), "VALUE = 1\n");
  await writeFile(join(changedPythonRoot, "tests", "test_alpha.py"), "def test_alpha(): assert True\n");
  await initializeGitRepository(changedPythonRoot);
  await writeFile(join(changedPythonRoot, "alpha.py"), "VALUE = 2\n");
  const changedPython = await resolveChangedTestsProfile({ workspaceRoot: changedPythonRoot });
  assert.equal(changedPython.profile, "python");
  assert.equal(changedPython.command, "uv run pytest \"tests/test_alpha.py\"");

  const changedNodeRoot = join(root, "changed-node");
  await mkdir(join(changedNodeRoot, "src"), { recursive: true });
  await writeFile(
    join(changedNodeRoot, "package.json"),
    JSON.stringify({ scripts: { test: "vitest run" } }),
  );
  await writeFile(join(changedNodeRoot, "src", "sample.ts"), "export const value = 1;\n");
  await writeFile(join(changedNodeRoot, "src", "sample.test.ts"), "export {};\n");
  await initializeGitRepository(changedNodeRoot);
  await writeFile(join(changedNodeRoot, "src", "sample.ts"), "export const value = 2;\n");
  await assert.rejects(
    () => resolveChangedTestsProfile({ workspaceRoot: changedNodeRoot }),
    (error: unknown) => {
      assert.ok(error instanceof ProjectProfileResolutionError);
      assert.equal(error.kind, "unsupported_action_for_profile");
      return true;
    },
  );

  const unmappedWorkbridgeRoot = join(root, "unmapped-workbridge");
  await mkdir(join(unmappedWorkbridgeRoot, "src"), { recursive: true });
  await writeFile(
    join(unmappedWorkbridgeRoot, "package.json"),
    JSON.stringify({ name: "@waishnav/devspace" }),
  );
  await writeFile(join(unmappedWorkbridgeRoot, "src", "workspace-actions.ts"), "export {};\n");
  await writeFile(join(unmappedWorkbridgeRoot, "src", "unmapped.ts"), "export const value = 1;\n");
  await initializeGitRepository(unmappedWorkbridgeRoot);
  await writeFile(join(unmappedWorkbridgeRoot, "src", "unmapped.ts"), "export const value = 2;\n");
  await assert.rejects(
    () => resolveChangedTestsProfile({ workspaceRoot: unmappedWorkbridgeRoot }),
    (error: unknown) => {
      assert.ok(error instanceof ProjectProfileResolutionError);
      assert.equal(error.kind, "no_exact_test_mapping");
      return true;
    },
  );

  const pnpmRoot = join(root, "pnpm");
  await mkdir(pnpmRoot, { recursive: true });
  await writeFile(
    join(pnpmRoot, "package.json"),
    JSON.stringify({
      packageManager: "pnpm@10.0.0",
      scripts: { lint: "eslint .", test: "vitest run" },
    }),
  );
  await writeFile(join(pnpmRoot, "package-lock.json"), "{}\n");
  const pnpm = await resolveProjectVerifyProfile({ workspaceRoot: pnpmRoot });
  assert.equal(pnpm.command, "pnpm run lint && pnpm run test");
  assert.match(pnpm.evidence.join("\n"), /package manager: pnpm/);

  const yarnRoot = join(root, "yarn");
  await mkdir(yarnRoot, { recursive: true });
  await writeFile(join(yarnRoot, "package.json"), JSON.stringify({ scripts: { build: "vite build" } }));
  await writeFile(join(yarnRoot, "yarn.lock"), "# yarn lockfile\n");
  const yarn = await resolveProjectVerifyProfile({ workspaceRoot: yarnRoot });
  assert.equal(yarn.command, "yarn run build");

  const bunRoot = join(root, "bun");
  await mkdir(bunRoot, { recursive: true });
  await writeFile(join(bunRoot, "package.json"), JSON.stringify({ scripts: { test: "bun test" } }));
  await writeFile(join(bunRoot, "bun.lock"), "lockfileVersion = 1\n");
  const bun = await resolveProjectVerifyProfile({ workspaceRoot: bunRoot });
  assert.equal(bun.command, "bun run test");

  const ambiguousRoot = join(root, "ambiguous-manager");
  await mkdir(ambiguousRoot, { recursive: true });
  await writeFile(join(ambiguousRoot, "package.json"), JSON.stringify({ scripts: { test: "node test.js" } }));
  await writeFile(join(ambiguousRoot, "package-lock.json"), "{}\n");
  await writeFile(join(ambiguousRoot, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
  await assert.rejects(
    () => resolveProjectVerifyProfile({ workspaceRoot: ambiguousRoot }),
    (error: unknown) => {
      assert.ok(error instanceof ProjectProfileResolutionError);
      assert.equal(error.kind, "ambiguous_package_manager");
      return true;
    },
  );

  const unsupportedManagerRoot = join(root, "unsupported-manager");
  await mkdir(unsupportedManagerRoot, { recursive: true });
  await writeFile(
    join(unsupportedManagerRoot, "package.json"),
    JSON.stringify({ packageManager: "deno@2.0.0", scripts: { test: "deno test" } }),
  );
  await assert.rejects(
    () => resolveProjectVerifyProfile({ workspaceRoot: unsupportedManagerRoot }),
    (error: unknown) => {
      assert.ok(error instanceof ProjectProfileResolutionError);
      assert.equal(error.kind, "unsupported_package_manager");
      return true;
    },
  );

  await assert.rejects(
    () => resolveProjectVerifyProfile({
      workspaceRoot: nodeRoot,
      requestedProfile: "workbridge",
    }),
    (error: unknown) => {
      assert.ok(error instanceof ProjectProfileResolutionError);
      assert.equal(error.kind, "unsupported_project_profile");
      return true;
    },
  );

  await assert.rejects(
    () => resolveProjectVerifyProfile({
      workspaceRoot: nodeRoot,
      requestedProfile: "python",
    }),
    (error: unknown) => {
      assert.ok(error instanceof ProjectProfileResolutionError);
      assert.equal(error.kind, "unsupported_project_profile");
      return true;
    },
  );

  const emptyNodeRoot = join(root, "empty-node");
  await mkdir(emptyNodeRoot, { recursive: true });
  await writeFile(join(emptyNodeRoot, "package.json"), JSON.stringify({ scripts: { custom: "echo custom" } }));
  await assert.rejects(
    () => resolveProjectVerifyProfile({ workspaceRoot: emptyNodeRoot }),
    (error: unknown) => {
      assert.ok(error instanceof ProjectProfileResolutionError);
      assert.equal(error.kind, "unsupported_action_for_profile");
      return true;
    },
  );

  const invalidRoot = join(root, "invalid");
  await mkdir(invalidRoot, { recursive: true });
  await writeFile(join(invalidRoot, "package.json"), "not-json");
  await assert.rejects(
    () => resolveProjectVerifyProfile({ workspaceRoot: invalidRoot }),
    (error: unknown) => {
      assert.ok(error instanceof ProjectProfileResolutionError);
      assert.equal(error.kind, "invalid_project_manifest");
      return true;
    },
  );

  const unsupportedRoot = join(root, "unsupported");
  await mkdir(unsupportedRoot, { recursive: true });
  await assert.rejects(
    () => resolveProjectVerifyProfile({ workspaceRoot: unsupportedRoot }),
    (error: unknown) => {
      assert.ok(error instanceof ProjectProfileResolutionError);
      assert.equal(error.kind, "unsupported_project_profile");
      return true;
    },
  );
} finally {
  await rm(root, { recursive: true, force: true });
}

async function initializeGitRepository(path: string): Promise<void> {
  await execFileAsync("git", ["init", path], { windowsHide: true });
  await execFileAsync("git", ["-C", path, "config", "user.email", "workbridge-tests@example.invalid"], { windowsHide: true });
  await execFileAsync("git", ["-C", path, "config", "user.name", "Workbridge Tests"], { windowsHide: true });
  await execFileAsync("git", ["-C", path, "add", "."], { windowsHide: true });
  await execFileAsync("git", ["-C", path, "commit", "-m", "initial"], { windowsHide: true });
}
