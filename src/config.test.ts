import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "./config.js";

const emptyConfigDir = mkdtempSync(join(tmpdir(), "workbridge-empty-config-test-"));
const baseEnv = {
  DEVSPACE_CONFIG_DIR: emptyConfigDir,
  DEVSPACE_ALLOWED_ROOTS: process.cwd(),
  DEVSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
};

const fixed = loadConfig(baseEnv);
assert.equal(fixed.toolMode, "codex");
assert.equal(fixed.widgets, "off");
assert.equal(fixed.artifactsEnabled, true);
assert.equal(fixed.artifactMaxFileBytes, 100 * 1024 * 1024);
assert.equal(fixed.skillsEnabled, true);
assert.equal(fixed.subagents, false);

const deprecatedOptionsIgnored = loadConfig({
  ...baseEnv,
  DEVSPACE_TOOL_MODE: "full",
  DEVSPACE_MINIMAL_TOOLS: "1",
  DEVSPACE_WIDGETS: "full",
  DEVSPACE_ARTIFACTS: "0",
  DEVSPACE_SKILLS: "0",
  DEVSPACE_SUBAGENTS: "1",
});
assert.equal(deprecatedOptionsIgnored.toolMode, "codex");
assert.equal(deprecatedOptionsIgnored.widgets, "off");
assert.equal(deprecatedOptionsIgnored.artifactsEnabled, true);
assert.equal(deprecatedOptionsIgnored.skillsEnabled, true);
assert.equal(deprecatedOptionsIgnored.subagents, false);
assert.equal(deprecatedOptionsIgnored.logging.shellCommands, false);

assert.equal(loadConfig(baseEnv).oauth.maxRegisteredClients, 50);
assert.equal(loadConfig(baseEnv).oauth.inactiveClientMaxAgeSeconds, 90 * 24 * 60 * 60);
assert.equal(loadConfig(baseEnv).oauth.authorizationRateLimit.maxFailures, 5);
assert.equal(loadConfig(baseEnv).oauth.authorizationRateLimit.failureWindowMs, 300_000);
assert.equal(loadConfig(baseEnv).oauth.authorizationRateLimit.blockDurationMs, 900_000);
assert.equal(loadConfig(baseEnv).oauth.authorizationRateLimit.failureDelayMs, 250);
assert.equal(loadConfig(baseEnv).workspaceSessionMaxAgeMs, 30 * 24 * 60 * 60 * 1_000);
assert.equal(
  loadConfig({ ...baseEnv, DEVSPACE_ARTIFACT_MAX_FILE_BYTES: "123" }).artifactMaxFileBytes,
  123,
);
assert.equal(loadConfig(baseEnv).devspaceSkillsDir, join(emptyConfigDir, "skills"));
assert.equal(loadConfig(baseEnv).devspaceAgentsDir, join(emptyConfigDir, "agents"));

const defaultConfig = loadConfig(baseEnv);
assert.deepEqual(defaultConfig.logging, {
  level: "info",
  format: "json",
  file: true,
  filePath: join(defaultConfig.stateDir, "logs", "devspace.jsonl"),
  fileMaxBytes: 10 * 1024 * 1024,
  fileMaxFiles: 5,
  consoleJson: false,
  requests: true,
  assets: false,
  toolCalls: true,
  shellCommands: false,
  trustProxy: false,
});

assert.equal(loadConfig({ ...baseEnv, WORKBRIDGE_LOG_SHELL_COMMANDS: "1" }).logging.shellCommands, true);
assert.equal(loadConfig({ ...baseEnv, DEVSPACE_LOG_LEVEL: "silent" }).logging.level, "silent");
assert.equal(loadConfig({ ...baseEnv, DEVSPACE_LOG_LEVEL: "error" }).logging.level, "error");
assert.equal(loadConfig({ ...baseEnv, DEVSPACE_LOG_LEVEL: "warn" }).logging.level, "warn");
assert.equal(loadConfig({ ...baseEnv, DEVSPACE_LOG_LEVEL: "debug" }).logging.level, "debug");
assert.equal(loadConfig({ ...baseEnv, DEVSPACE_LOG_FORMAT: "pretty" }).logging.format, "pretty");
assert.equal(loadConfig({ ...baseEnv, DEVSPACE_LOG_FILE: "0" }).logging.file, false);
assert.equal(loadConfig({ ...baseEnv, DEVSPACE_LOG_FILE_PATH: "./custom.jsonl" }).logging.filePath, join(process.cwd(), "custom.jsonl"));
assert.equal(loadConfig({ ...baseEnv, DEVSPACE_LOG_FILE_MAX_BYTES: "4096" }).logging.fileMaxBytes, 4096);
assert.equal(loadConfig({ ...baseEnv, DEVSPACE_LOG_FILE_MAX_BYTES: "0" }).logging.fileMaxBytes, undefined);
assert.equal(loadConfig({ ...baseEnv, DEVSPACE_LOG_FILE_MAX_FILES: "2" }).logging.fileMaxFiles, 2);
assert.equal(loadConfig({ ...baseEnv, DEVSPACE_LOG_CONSOLE_JSON: "1" }).logging.consoleJson, true);
assert.equal(loadConfig({ ...baseEnv, DEVSPACE_LOG_REQUESTS: "0" }).logging.requests, false);
assert.equal(loadConfig({ ...baseEnv, DEVSPACE_LOG_ASSETS: "1" }).logging.assets, true);
assert.equal(loadConfig({ ...baseEnv, DEVSPACE_LOG_TOOL_CALLS: "0" }).logging.toolCalls, false);
assert.equal(loadConfig({ ...baseEnv, DEVSPACE_TRUST_PROXY: "1" }).logging.trustProxy, true);

assert.throws(() => loadConfig({ ...baseEnv, DEVSPACE_LOG_LEVEL: "trace" }), /Invalid DEVSPACE_LOG_LEVEL/);
assert.throws(() => loadConfig({ ...baseEnv, DEVSPACE_LOG_FORMAT: "color" }), /Invalid DEVSPACE_LOG_FORMAT/);
assert.throws(() => loadConfig({ ...baseEnv, DEVSPACE_LOG_FILE_MAX_BYTES: "-1" }), /Invalid DEVSPACE_LOG_FILE_MAX_BYTES/);
assert.throws(() => loadConfig({ ...baseEnv, DEVSPACE_LOG_FILE_MAX_FILES: "0" }), /Invalid DEVSPACE_LOG_FILE_MAX_FILES/);

assert.equal(loadConfig(baseEnv).oauth.ownerToken, "test-owner-token-that-is-long-enough");
assert.deepEqual(loadConfig(baseEnv).oauth.scopes, ["devspace"]);
assert.deepEqual(loadConfig(baseEnv).oauth.allowedRedirectHosts, ["chatgpt.com", "localhost", "127.0.0.1"]);
assert.equal(loadConfig(baseEnv).oauth.accessTokenTtlSeconds, 3600);
assert.equal(loadConfig(baseEnv).oauth.refreshTokenTtlSeconds, 2592000);
assert.deepEqual(loadConfig({ ...baseEnv, DEVSPACE_OAUTH_SCOPES: "devspace,admin" }).oauth.scopes, ["devspace", "admin"]);
assert.deepEqual(
  loadConfig({ ...baseEnv, DEVSPACE_OAUTH_ALLOWED_REDIRECT_HOSTS: "chatgpt.com,example.com" }).oauth.allowedRedirectHosts,
  ["chatgpt.com", "example.com"],
);
assert.equal(loadConfig({ ...baseEnv, DEVSPACE_OAUTH_ACCESS_TOKEN_TTL_SECONDS: "120" }).oauth.accessTokenTtlSeconds, 120);
assert.equal(loadConfig({ ...baseEnv, DEVSPACE_OAUTH_REFRESH_TOKEN_TTL_SECONDS: "240" }).oauth.refreshTokenTtlSeconds, 240);
assert.throws(
  () => loadConfig({ DEVSPACE_CONFIG_DIR: emptyConfigDir, DEVSPACE_ALLOWED_ROOTS: process.cwd() }),
  /DEVSPACE_OAUTH_OWNER_TOKEN is required/,
);
assert.throws(() => loadConfig({ ...baseEnv, DEVSPACE_OAUTH_OWNER_TOKEN: "too-short" }), /must be at least 16 characters/);
assert.throws(() => loadConfig({ ...baseEnv, DEVSPACE_OAUTH_ACCESS_TOKEN_TTL_SECONDS: "0" }), /Invalid DEVSPACE_OAUTH_ACCESS_TOKEN_TTL_SECONDS/);
assert.throws(() => loadConfig({ ...baseEnv, DEVSPACE_ARTIFACT_MAX_FILE_BYTES: "0" }), /Invalid DEVSPACE_ARTIFACT_MAX_FILE_BYTES/);

assert.equal(loadConfig(baseEnv).publicBaseUrl, "http://127.0.0.1:7676");
assert.deepEqual(loadConfig(baseEnv).allowedHosts, ["localhost", "127.0.0.1", "::1"]);
assert.equal(loadConfig({ ...baseEnv, DEVSPACE_PUBLIC_BASE_URL: "https://abc.trycloudflare.com/" }).publicBaseUrl, "https://abc.trycloudflare.com");
assert.deepEqual(
  loadConfig({ ...baseEnv, DEVSPACE_PUBLIC_BASE_URL: "https://abc.trycloudflare.com/" }).allowedHosts,
  ["localhost", "127.0.0.1", "::1", "abc.trycloudflare.com"],
);
assert.deepEqual(loadConfig({ ...baseEnv, DEVSPACE_ALLOWED_HOSTS: "*" }).allowedHosts, ["*"]);

const configDir = mkdtempSync(join(tmpdir(), "workbridge-config-test-"));
writeFileSync(
  join(configDir, "config.json"),
  JSON.stringify({
    port: 8787,
    allowedRoots: [process.cwd()],
    publicBaseUrl: "https://workbridge.example.com",
    subagents: true,
    artifactsEnabled: false,
    artifactMaxFileBytes: 321,
  }),
);
writeFileSync(
  join(configDir, "auth.json"),
  JSON.stringify({ ownerToken: "persisted-owner-token-long-enough" }),
);
const fileConfig = loadConfig({ DEVSPACE_CONFIG_DIR: configDir });
assert.equal(fileConfig.port, 8787);
assert.equal(fileConfig.oauth.ownerToken, "persisted-owner-token-long-enough");
assert.equal(fileConfig.publicBaseUrl, "https://workbridge.example.com");
assert.equal(fileConfig.subagents, false);
assert.equal(fileConfig.artifactsEnabled, true);
assert.equal(fileConfig.artifactMaxFileBytes, 321);
