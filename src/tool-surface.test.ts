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

function surface(mode: "minimal" | "full" | "codex") {
  const config = loadConfig({ ...baseEnv, DEVSPACE_TOOL_MODE: mode });
  const toolNames = toolNamesFor(config);
  return {
    tools: expectedRegisteredToolNames(config, toolNames),
    hidden: hiddenRegisteredToolNames(config, toolNames),
    profiles: enabledToolProfiles(config),
  };
}

const minimal = surface("minimal");
assert.ok(minimal.tools.includes("workbridge_guide"));
assert.ok(minimal.tools.includes("workbridge_efficiency_report"));
assert.ok(minimal.tools.includes("open_workspace"));
assert.ok(minimal.tools.includes("read"));
assert.ok(minimal.tools.includes("bash"));
assert.ok(minimal.tools.includes("edit"));
assert.ok(!minimal.tools.includes("apply_patch"));
assert.ok(!minimal.tools.includes("exec_command"));
assert.ok(!minimal.tools.includes("write_stdin"));
assert.ok(!minimal.tools.includes("grep"));
assert.ok(!minimal.tools.includes("glob"));
assert.ok(!minimal.tools.includes("ls"));
assert.ok(minimal.hidden.includes("apply_patch"));
assert.ok(minimal.hidden.includes("exec_command"));
assert.ok(minimal.hidden.includes("write_stdin"));
assert.ok(minimal.hidden.includes("read_many"));
assert.ok(!minimal.hidden.includes("read"));
assert.ok(minimal.profiles.includes("tool_mode_minimal"));

const full = surface("full");
assert.ok(full.tools.includes("bash"));
assert.ok(full.tools.includes("write"));
assert.ok(full.tools.includes("grep"));
assert.ok(full.tools.includes("glob"));
assert.ok(full.tools.includes("ls"));
assert.ok(!full.tools.includes("apply_patch"));
assert.ok(!full.tools.includes("exec_command"));
assert.ok(!full.tools.includes("write_stdin"));
assert.ok(full.hidden.includes("apply_patch"));
assert.ok(full.profiles.includes("tool_mode_full"));

const codex = surface("codex");
assert.ok(codex.tools.includes("workbridge_guide"));
assert.ok(codex.tools.includes("workbridge_efficiency_report"));
assert.ok(codex.tools.includes("open_workspace"));
assert.ok(codex.tools.includes("read"));
assert.ok(codex.tools.includes("apply_patch"));
assert.ok(codex.tools.includes("exec_command"));
assert.ok(codex.tools.includes("write_stdin"));
assert.ok(codex.tools.includes("workspace_snapshot"));
assert.ok(codex.tools.includes("grep_context"));
assert.ok(!codex.tools.includes("bash"));
assert.ok(!codex.tools.includes("grep"));
assert.ok(!codex.tools.includes("glob"));
assert.ok(!codex.tools.includes("ls"));
assert.ok(codex.hidden.includes("bash"));

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
assert.ok(codex.hidden.includes("read_many"));
assert.ok(!codex.hidden.includes("read"));
assert.ok(codex.profiles.includes("tool_mode_codex"));

for (const item of [minimal, full, codex]) {
  assert.equal(new Set(item.tools).size, item.tools.length);
  assert.equal(new Set(item.hidden).size, item.hidden.length);
  for (const visible of item.tools) {
    assert.ok(!item.hidden.includes(visible), `visible tool is also hidden: ${visible}`);
  }
}
