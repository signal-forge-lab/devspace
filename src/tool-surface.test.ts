import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "./config.js";
import {
  enabledToolProfiles,
  expectedRegisteredToolNames,
  hiddenRegisteredToolNames,
  toolNamesFor,
} from "./server.js";

const configDir = mkdtempSync(join(tmpdir(), "workbridge-tool-surface-"));
const baseEnv = {
  DEVSPACE_CONFIG_DIR: configDir,
  DEVSPACE_ALLOWED_ROOTS: process.cwd(),
  DEVSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
  DEVSPACE_WIDGETS: "off",
};

function surface(mode: "minimal" | "full" | "codex" | "main") {
  const config = loadConfig({ ...baseEnv, DEVSPACE_TOOL_MODE: mode });
  const toolNames = toolNamesFor(config);
  return {
    tools: expectedRegisteredToolNames(config, toolNames),
    hidden: hiddenRegisteredToolNames(config, toolNames),
    profiles: enabledToolProfiles(config),
  };
}

for (const envName of [
  "WORKBRIDGE_ENABLE_PROCESS_TOOLS",
  "DEVSPACE_ENABLE_PROCESS_TOOLS",
  "WORKBRIDGE_ENABLE_WORKSPACE_TASKS",
  "DEVSPACE_ENABLE_WORKSPACE_TASKS",
]) {
  delete process.env[envName];
}

const disabledNonZipTools = [
  "workbridge_guide",
  "workbridge_efficiency_report",
  "record_tool_event",
  "edit_plan_preflight",
  "safe_operation_router",
  "bash_preflight",
  "task_checkpoint",
  "task_resume",
  "record_workflow_event",
  "show_changes",
];

const forkTools = [
  "workspace_snapshot",
  "edit_by_line_range",
  "edit_preflight_index",
  "create_workspace_index",
  "read_index_ranges",
  "git_status",
  "git_diff_ranges",
  "git_commit_files",
  "grep_context",
  "file_outline",
  "insert_by_anchor",
  "replace_symbol",
  "git_recent_commits",
  "git_stage_files",
  "git_stage_hunks",
  "git_commit_staged",
  "workbridge_router",
  "workbridge_verify",
  "apply_unified_patch",
  "resolve_locator",
  "apply_structured_edit",
  "check_workspace_invariants",
  "read_many",
  "edit_many",
];

function assertAlwaysHidden(item: ReturnType<typeof surface>, mode: string) {
  for (const tool of disabledNonZipTools) {
    assert.ok(!item.tools.includes(tool), `${tool} should not be visible in ${mode} mode`);
    assert.ok(item.hidden.includes(tool), `${tool} should stay hidden in ${mode} mode`);
  }
}

function assertForkDisabled(item: ReturnType<typeof surface>, mode: string) {
  for (const tool of forkTools) {
    assert.ok(!item.tools.includes(tool), `${tool} should not be visible in ${mode} mode`);
    assert.ok(item.hidden.includes(tool), `${tool} should stay hidden in ${mode} mode`);
  }
}

const minimal = surface("minimal");
assert.ok(minimal.tools.includes("open_workspace"));
assert.ok(minimal.tools.includes("read"));
assert.ok(minimal.tools.includes("bash"));
assert.ok(minimal.tools.includes("edit"));
assert.ok(minimal.tools.includes("workspace_snapshot"));
assert.ok(minimal.tools.includes("grep_context"));
assert.ok(!minimal.tools.includes("apply_patch"));
assert.ok(!minimal.tools.includes("exec_command"));
assert.ok(!minimal.tools.includes("write_stdin"));
assert.ok(!minimal.tools.includes("launch_workspace_task"));
assert.ok(!minimal.tools.includes("grep"));
assert.ok(!minimal.tools.includes("glob"));
assert.ok(!minimal.tools.includes("ls"));
assertAlwaysHidden(minimal, "minimal");
assert.ok(minimal.hidden.includes("apply_patch"));
assert.ok(minimal.hidden.includes("exec_command"));
assert.ok(minimal.hidden.includes("write_stdin"));
assert.ok(minimal.hidden.includes("launch_workspace_task"));
assert.ok(minimal.hidden.includes("read_many"));
assert.ok(!minimal.hidden.includes("read"));
assert.ok(minimal.profiles.includes("tool_mode_minimal"));

const main = surface("main");
for (const tool of ["open_workspace", "read", "write", "edit", "bash", "grep", "glob", "ls"]) {
  assert.ok(main.tools.includes(tool), `${tool} should be visible in main mode`);
  assert.ok(!main.hidden.includes(tool), `${tool} should not be hidden in main mode`);
}
assert.ok(!main.tools.includes("apply_patch"));
assert.ok(!main.tools.includes("exec_command"));
assert.ok(!main.tools.includes("write_stdin"));
assert.ok(!main.tools.includes("launch_workspace_task"));
assertAlwaysHidden(main, "main");
assertForkDisabled(main, "main");
assert.ok(main.profiles.includes("tool_mode_main"));

const full = surface("full");
assert.ok(full.tools.includes("bash"));
assert.ok(full.tools.includes("write"));
assert.ok(full.tools.includes("grep"));
assert.ok(full.tools.includes("glob"));
assert.ok(full.tools.includes("ls"));
assert.ok(full.tools.includes("insert_by_anchor"));
assert.ok(full.tools.includes("replace_symbol"));
assert.ok(!full.tools.includes("edit_plan_preflight"));
assert.ok(!full.tools.includes("safe_operation_router"));
assert.ok(!full.tools.includes("apply_patch"));
assert.ok(!full.tools.includes("exec_command"));
assert.ok(!full.tools.includes("write_stdin"));
assert.ok(!full.tools.includes("launch_workspace_task"));
assertAlwaysHidden(full, "full");
assert.ok(full.hidden.includes("apply_patch"));
assert.ok(full.profiles.includes("tool_mode_full"));

const codex = surface("codex");
for (const tool of ["open_workspace", "read", "write", "edit", "bash", "grep", "glob", "ls", "apply_patch", "exec_command", "write_stdin"]) {
  assert.ok(codex.tools.includes(tool), `${tool} should be visible in codex mode`);
  assert.ok(!codex.hidden.includes(tool), `${tool} should not be hidden in codex mode`);
}
assert.ok(!codex.tools.includes("launch_workspace_task"));
assertAlwaysHidden(codex, "codex");
assertForkDisabled(codex, "codex");
assert.ok(codex.hidden.includes("launch_workspace_task"));
assert.ok(codex.profiles.includes("tool_mode_codex"));

process.env.WORKBRIDGE_ENABLE_PROCESS_TOOLS = "1";
try {
  const minimalWithProcessTools = surface("minimal");
  assert.ok(minimalWithProcessTools.tools.includes("exec_command"));
  assert.ok(minimalWithProcessTools.tools.includes("write_stdin"));
  assert.ok(!minimalWithProcessTools.tools.includes("apply_patch"));
  assert.ok(!minimalWithProcessTools.hidden.includes("exec_command"));
  assert.ok(!minimalWithProcessTools.hidden.includes("write_stdin"));
  assert.ok(minimalWithProcessTools.hidden.includes("apply_patch"));
  assert.ok(minimalWithProcessTools.profiles.includes("process_tools"));

  const fullWithProcessTools = surface("full");
  assert.ok(fullWithProcessTools.tools.includes("exec_command"));
  assert.ok(fullWithProcessTools.tools.includes("write_stdin"));
  assert.ok(!fullWithProcessTools.tools.includes("apply_patch"));
  assert.ok(!fullWithProcessTools.hidden.includes("exec_command"));
  assert.ok(!fullWithProcessTools.hidden.includes("write_stdin"));
  assert.ok(fullWithProcessTools.hidden.includes("apply_patch"));
  assert.ok(fullWithProcessTools.profiles.includes("process_tools"));

  const mainWithProcessTools = surface("main");
  assert.ok(mainWithProcessTools.tools.includes("exec_command"));
  assert.ok(mainWithProcessTools.tools.includes("write_stdin"));
  assertForkDisabled(mainWithProcessTools, "main with process tools");
} finally {
  delete process.env.WORKBRIDGE_ENABLE_PROCESS_TOOLS;
}

process.env.DEVSPACE_ENABLE_PROCESS_TOOLS = "1";
try {
  const minimalWithLegacyProcessFlag = surface("minimal");
  assert.ok(minimalWithLegacyProcessFlag.tools.includes("exec_command"));
  assert.ok(minimalWithLegacyProcessFlag.tools.includes("write_stdin"));
  assert.ok(minimalWithLegacyProcessFlag.profiles.includes("process_tools"));
} finally {
  delete process.env.DEVSPACE_ENABLE_PROCESS_TOOLS;
}

process.env.WORKBRIDGE_ENABLE_WORKSPACE_TASKS = "1";
try {
  const minimalWithWorkspaceTasks = surface("minimal");
  assert.ok(minimalWithWorkspaceTasks.tools.includes("launch_workspace_task"));
  assert.ok(!minimalWithWorkspaceTasks.hidden.includes("launch_workspace_task"));
  assert.ok(minimalWithWorkspaceTasks.profiles.includes("workspace_tasks"));

  const mainWithWorkspaceTasks = surface("main");
  assert.ok(mainWithWorkspaceTasks.tools.includes("launch_workspace_task"));
  assert.ok(!mainWithWorkspaceTasks.hidden.includes("launch_workspace_task"));
  assertForkDisabled(mainWithWorkspaceTasks, "main with workspace tasks");

  const codexWithWorkspaceTasks = surface("codex");
  assert.ok(codexWithWorkspaceTasks.tools.includes("launch_workspace_task"));
  assert.ok(!codexWithWorkspaceTasks.hidden.includes("launch_workspace_task"));
  assertForkDisabled(codexWithWorkspaceTasks, "codex with workspace tasks");
  assert.ok(codexWithWorkspaceTasks.profiles.includes("workspace_tasks"));
} finally {
  delete process.env.WORKBRIDGE_ENABLE_WORKSPACE_TASKS;
}

process.env.DEVSPACE_ENABLE_WORKSPACE_TASKS = "1";
try {
  const minimalWithLegacyWorkspaceTasks = surface("minimal");
  assert.ok(minimalWithLegacyWorkspaceTasks.tools.includes("launch_workspace_task"));
  assert.ok(minimalWithLegacyWorkspaceTasks.profiles.includes("workspace_tasks"));
} finally {
  delete process.env.DEVSPACE_ENABLE_WORKSPACE_TASKS;
}

for (const item of [minimal, main, full, codex]) {
  assert.equal(new Set(item.tools).size, item.tools.length);
  assert.equal(new Set(item.hidden).size, item.hidden.length);
  for (const visible of item.tools) {
    assert.ok(!item.hidden.includes(visible), `visible tool is also hidden: ${visible}`);
  }
}