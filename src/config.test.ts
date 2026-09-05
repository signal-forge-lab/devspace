import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { loadConfig } from "./config.js";
import { writeDevspaceAuth, writeDevspaceConfig } from "./user-config.js";

const configDir = mkdtempSync(join(tmpdir(), "devspace-config-test-"));
const env = {
  DEVSPACE_CONFIG_DIR: configDir,
  DEVSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
};

try {
  const defaults = loadConfig(env);
  assert.equal(defaults.host, "127.0.0.1");
  assert.equal(defaults.port, 7676);
  assert.equal(defaults.publicBaseUrl, "http://127.0.0.1:7676");
  assert.deepEqual(defaults.allowedRoots, [process.cwd()]);
  assert.deepEqual(defaults.allowedHosts, ["localhost", "127.0.0.1", "::1"]);
  assert.equal(defaults.toolMode, "codex");
  assert.equal(defaults.uiEnabled, false);
  assert.equal(defaults.skillsEnabled, true);
  assert.equal(defaults.artifactsEnabled, true);
  assert.deepEqual(defaults.subagents, { enabled: false, providers: [] });
  assert.equal(defaults.logging.level, "info");
  assert.equal(defaults.logging.format, "json");
  assert.equal(defaults.logging.file, true);
  assert.match(defaults.logging.filePath ?? "", /devspace\.jsonl$/);
  assert.equal(defaults.logging.fileMaxFiles, 5);
  assert.equal(defaults.logging.requests, true);
  assert.equal(defaults.logging.assets, false);
  assert.equal(defaults.logging.toolCalls, true);
  assert.equal(defaults.logging.shellCommands, false);
  assert.equal(defaults.logging.trustProxy, false);

  writeDevspaceConfig({
    configVersion: 1,
    server: {
      host: "0.0.0.0",
      port: 8787,
      publicBaseUrl: "https://devspace.example.com/",
      allowedHosts: ["example.internal"],
      trustProxy: true,
    },
    workspaces: {
      allowedRoots: ["~/work"],
      auxiliaryRoots: ["~/.codex"],
      worktreeRoot: "~/work/.workbridge/worktrees",
    },
    storage: { stateDir: "~/state" },
    tools: { mode: "claude" },
    ui: { enabled: false },
    artifacts: { enabled: true, maxFileBytes: 321 },
    skills: { enabled: false, paths: ["~/skills"], agentDir: "~/agent" },
    subagents: {
      enabled: true,
      providers: [{ id: "codex", enabled: true }],
    },
    logging: {
      level: "debug",
      format: "pretty",
      requests: false,
      assets: true,
      toolCalls: false,
      shellCommands: true,
    },
    oauth: {
      accessTokenTtlSeconds: 120,
      refreshTokenTtlSeconds: 240,
      scopes: ["devspace", "admin"],
      allowedRedirectHosts: ["chatgpt.com", "example.com"],
    },
  }, env);
  writeDevspaceAuth({ ownerToken: "persisted-owner-token-long-enough" }, env);

  const configured = loadConfig({ DEVSPACE_CONFIG_DIR: configDir });
  assert.equal(configured.configDir, configDir);
  assert.equal(configured.host, "0.0.0.0");
  assert.equal(configured.port, 8787);
  assert.equal(configured.publicBaseUrl, "https://devspace.example.com");
  assert.deepEqual(configured.allowedRoots, [resolve(homedir(), "work")]);
  assert.deepEqual(configured.allowedHosts, [
    "localhost",
    "127.0.0.1",
    "::1",
    "0.0.0.0",
    "devspace.example.com",
    "example.internal",
  ]);
  assert.equal(configured.toolMode, "codex");
  assert.equal(configured.uiEnabled, false);
  assert.equal(configured.stateDir, resolve(homedir(), "state"));
  assert.deepEqual(configured.auxiliaryRoots, [resolve(homedir(), ".codex")]);
  assert.equal(configured.worktreeRoot, resolve(homedir(), "work", ".workbridge", "worktrees"));
  assert.equal(configured.artifactsEnabled, true);
  assert.equal(configured.artifactMaxFileBytes, 321);
  assert.equal(configured.skillsEnabled, true);
  assert.deepEqual(configured.skillPaths, ["~/skills"]);
  assert.equal(configured.agentDir, resolve(homedir(), "agent"));
  assert.equal(configured.subagents.enabled, false);
  assert.equal(configured.oauth?.ownerToken, "persisted-owner-token-long-enough");
  assert.equal(configured.oauth?.accessTokenTtlSeconds, 120);
  assert.deepEqual(configured.oauth?.scopes, ["devspace", "admin"]);
  assert.equal(configured.logging.level, "debug");
  assert.equal(configured.logging.format, "pretty");
  assert.equal(configured.logging.requests, false);
  assert.equal(configured.logging.assets, true);
  assert.equal(configured.logging.toolCalls, false);
  assert.equal(configured.logging.shellCommands, true);
  assert.equal(configured.logging.trustProxy, true);

  assert.equal(loadConfig(env).oauth?.ownerToken, env.DEVSPACE_OAUTH_OWNER_TOKEN);
} finally {
  rmSync(configDir, { recursive: true, force: true });
}

const tunnelDir = mkdtempSync(join(tmpdir(), "workbridge-tunnel-config-test-"));
try {
  writeDevspaceConfig({
    configVersion: 1,
    server: { mcpConnectionMode: "openai-secure-mcp-tunnel" },
  }, { DEVSPACE_CONFIG_DIR: tunnelDir });
  const tunnelConfig = loadConfig({ DEVSPACE_CONFIG_DIR: tunnelDir });
  assert.equal(tunnelConfig.mcpConnectionMode, "openai-secure-mcp-tunnel");
  assert.equal(tunnelConfig.oauth, undefined);
} finally {
  rmSync(tunnelDir, { recursive: true, force: true });
}

const missingAuthDir = mkdtempSync(join(tmpdir(), "devspace-config-no-auth-test-"));
try {
  assert.throws(
    () => loadConfig({ DEVSPACE_CONFIG_DIR: missingAuthDir }),
    /OAuth owner token is required/,
  );
} finally {
  rmSync(missingAuthDir, { recursive: true, force: true });
}

console.log("config tests passed");
