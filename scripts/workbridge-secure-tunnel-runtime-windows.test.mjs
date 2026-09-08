import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import powerShellRunner from "../desktop/monitor/powershell.cjs";

if (process.platform !== "win32") {
  console.log("workbridge secure tunnel runtime test skipped: Windows only");
  process.exit(0);
}

const powershell = powerShellRunner.resolvePowerShellExecutable();

const root = mkdtempSync(path.join(tmpdir(), "workbridge-tunnel-runtime-test-"));
const fakeClient = path.join(root, "tunnel-client.cmd");
const invocationLog = path.join(root, "invocations.log");
const runtimeState = path.join(root, "runtime-ready.txt");
const appData = path.join(root, "AppData", "Roaming");
const userProfile = path.join(root, "UserProfile");
const sopsSecretDir = path.join(userProfile, ".config", "sops", "secrets");
const profileDir = path.join(appData, "@workbridge", "secure-tunnel", "profiles");
mkdirSync(profileDir, { recursive: true });
mkdirSync(sopsSecretDir, { recursive: true });
writeFileSync(path.join(sopsSecretDir, "global.sops.json"), "{}", "utf8");
writeFileSync(
  path.join(profileDir, "workbridge-mcp.yaml"),
  'control_plane:\r\n  tunnel_id: "tunnel_0123456789abcdef0123456789abcdef"\r\n',
  "utf8",
);
writeFileSync(fakeClient, [
  "@echo off",
  "echo %*>>\"%WORKBRIDGE_TUNNEL_TEST_LOG%\"",
  "if \"%1 %2\"==\"runtimes connect\" (",
  "  if not \"%WORKBRIDGE_TUNNEL_TEST_NEVER_READY%\"==\"1\" echo ready>\"%WORKBRIDGE_TUNNEL_TEST_STATE%\"",
  "  echo {\"ok\":true}",
  "  exit /b 0",
  ")",
  "if \"%1 %2\"==\"runtimes status\" (",
  "  if \"%WORKBRIDGE_TUNNEL_TEST_READY%\"==\"0\" if not exist \"%WORKBRIDGE_TUNNEL_TEST_STATE%\" (",
  "    echo {\"ready\":false,\"runtime_state\":\"stopped\",\"tunnel_id\":\"tunnel_0123456789abcdef0123456789abcdef\"}",
  "    exit /b 0",
  "  )",
  "  echo {\"ready\":true,\"runtime_state\":\"ready\",\"tunnel_id\":\"tunnel_0123456789abcdef0123456789abcdef\"}",
  "  exit /b 0",
  ")",
  "echo {\"ok\":true}",
  "exit /b 0",
  "",
].join("\r\n"));
const fakeSops = path.join(root, "sops.cmd");
writeFileSync(fakeSops, [
  "@echo off",
  "if \"%1\"==\"decrypt\" (",
  "  echo {\"CONTROL_PLANE_API_KEY\":\"sops-test-secret-never-log\"}",
  "  exit /b 0",
  ")",
  "exit /b 1",
  "",
].join("\r\n"));

const script = path.resolve("scripts/workbridge-secure-tunnel-runtime-windows.ps1");
const environment = {
  ...process.env,
  APPDATA: appData,
  USERPROFILE: userProfile,
  WORKBRIDGE_TUNNEL_CLIENT_PATH: fakeClient,
  WORKBRIDGE_TUNNEL_TEST_LOG: invocationLog,
  WORKBRIDGE_TUNNEL_TEST_STATE: runtimeState,
  CONTROL_PLANE_API_KEY: "test-secret-never-log",
};

const connect = spawnSync(powershell, [
  "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script,
  "-Action", "connect",
  "-TunnelId", "tunnel_0123456789abcdef0123456789abcdef",
], { encoding: "utf8", env: environment });

assert.equal(connect.status, 0, connect.stderr);
assert.doesNotMatch(connect.stdout, /test-secret-never-log/);
let invocations = readFileSync(invocationLog, "utf8");
assert.match(invocations, /runtimes connect/);
assert.match(invocations, /--runtime-api-key env:CONTROL_PLANE_API_KEY/);
assert.match(invocations, /runtimes status workbridge-mcp --json/);

const missingTunnelId = spawnSync(powershell, [
  "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script,
  "-Action", "connect",
], { encoding: "utf8", env: environment });
assert.notEqual(missingTunnelId.status, 0);
assert.match(`${missingTunnelId.stdout}${missingTunnelId.stderr}`, /TunnelId is required/);

for (const action of ["status", "stop"]) {
  const result = spawnSync(powershell, [
    "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script,
    "-Action", action,
  ], { encoding: "utf8", env: environment });
  assert.equal(result.status, 0, result.stderr);
  invocations = readFileSync(invocationLog, "utf8");
  assert.match(invocations, new RegExp(`runtimes ${action} workbridge-mcp --json`));
}

const beforeEnsure = readFileSync(invocationLog, "utf8");
const ensure = spawnSync(powershell, [
  "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script,
  "-Action", "ensure",
], { encoding: "utf8", env: environment });
assert.equal(ensure.status, 0, ensure.stderr);
const ensureInvocations = readFileSync(invocationLog, "utf8").slice(beforeEnsure.length);
assert.match(ensureInvocations, /runtimes status workbridge-mcp --json/);
assert.doesNotMatch(ensureInvocations, /runtimes connect/);

const beforeReconnect = readFileSync(invocationLog, "utf8");
rmSync(runtimeState, { force: true });
const reconnect = spawnSync(powershell, [
  "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script,
  "-Action", "ensure",
], {
  encoding: "utf8",
  env: { ...environment, WORKBRIDGE_TUNNEL_TEST_READY: "0" },
});
assert.equal(reconnect.status, 0, reconnect.stderr);
const reconnectInvocations = readFileSync(invocationLog, "utf8").slice(beforeReconnect.length);
assert.match(reconnectInvocations, /runtimes status workbridge-mcp --json/);
assert.match(reconnectInvocations, /runtimes connect/);
assert.match(reconnectInvocations, /--tunnel-id tunnel_0123456789abcdef0123456789abcdef/);
assert.doesNotMatch(reconnect.stdout, /test-secret-never-log/);

const sopsFallback = spawnSync(powershell, [
  "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script,
  "-Action", "connect",
  "-TunnelId", "tunnel_0123456789abcdef0123456789abcdef",
], {
  encoding: "utf8",
  env: {
    ...environment,
    CONTROL_PLANE_API_KEY: "",
    Path: `${root}${path.delimiter}${environment.Path ?? environment.PATH ?? ""}`,
  },
});
assert.equal(sopsFallback.status, 0, sopsFallback.stderr);
assert.doesNotMatch(sopsFallback.stdout, /sops-test-secret-never-log/);

const neverReady = spawnSync(powershell, [
  "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script,
  "-Action", "ensure",
], {
  encoding: "utf8",
  env: {
    ...environment,
    WORKBRIDGE_TUNNEL_TEST_READY: "0",
    WORKBRIDGE_TUNNEL_TEST_NEVER_READY: "1",
    WORKBRIDGE_TUNNEL_TEST_STATE: path.join(root, "never-ready.txt"),
  },
});
assert.notEqual(neverReady.status, 0);
assert.match(`${neverReady.stdout}${neverReady.stderr}`, /did not become ready after reconnect/);

const unconfigured = spawnSync(powershell, [
  "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script,
  "-Action", "ensure",
], {
  encoding: "utf8",
  env: {
    ...environment,
    APPDATA: path.join(root, "unconfigured-appdata"),
    WORKBRIDGE_TUNNEL_CLIENT_PATH: path.join(root, "missing-tunnel-client.exe"),
  },
});
assert.equal(unconfigured.status, 0, unconfigured.stderr);
assert.match(unconfigured.stdout, /"configured":false/);

const scriptSource = readFileSync(script, "utf8");
assert.match(scriptSource, /global\.sops\.json/);
assert.doesNotMatch(scriptSource, /GetEnvironmentVariable\("CONTROL_PLANE_API_KEY", "User"\)/);

console.log("workbridge secure tunnel runtime tests passed");
