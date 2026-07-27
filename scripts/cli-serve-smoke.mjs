import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const cliPath = resolve("dist/cli.js");
const cases = [
  { name: "default command", args: [] },
  { name: "serve command", args: ["serve"] },
];

for (const testCase of cases) {
  await testServeLifecycle(testCase);
}

async function testServeLifecycle(testCase) {
  const root = mkdtempSync(join(tmpdir(), "workbridge-cli-serve-"));
  const configDir = join(root, ".devspace");
  const stateDir = join(root, ".state");
  const projectRoot = join(root, "project");
  const worktreeRoot = join(root, "worktrees");
  const port = await reservePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const controlToken = `test-control-token-${process.pid}-${port}`;
  mkdirSync(configDir, { recursive: true });
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(projectRoot, { recursive: true });
  mkdirSync(worktreeRoot, { recursive: true });

  let stdout = "";
  let stderr = "";
  const child = spawn(process.execPath, [cliPath, ...testCase.args], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(port),
      DEVSPACE_CONFIG_DIR: configDir,
      DEVSPACE_STATE_DIR: stateDir,
      DEVSPACE_WORKTREE_ROOT: worktreeRoot,
      DEVSPACE_ALLOWED_ROOTS: projectRoot,
      DEVSPACE_ALLOWED_HOSTS: "127.0.0.1,localhost",
      DEVSPACE_PUBLIC_BASE_URL: baseUrl,
      DEVSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
      DEVSPACE_LOG_FILE: "0",
      DEVSPACE_LOG_REQUESTS: "0",
      DEVSPACE_LOG_TOOL_CALLS: "0",
      WORKBRIDGE_MONITOR_CONTROL_TOKEN: controlToken,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });

  try {
    const health = await waitForHealth(child, `${baseUrl}/healthz`, () => ({ stdout, stderr }));
    assert.equal(health.ok, true, `${testCase.name}: /healthz must report ok`);
    await delay(300);
    assert.equal(
      child.exitCode,
      null,
      `${testCase.name}: CLI exited after startup\n${formatOutput(stdout, stderr)}`,
    );

    const shutdownResponse = await fetch(`${baseUrl}/monitor/api/control/shutdown`, {
      method: "POST",
      headers: { authorization: `Bearer ${controlToken}` },
    });
    assert.equal(shutdownResponse.status, 202, `${testCase.name}: shutdown must be accepted`);

    const result = await waitForExit(child, 15_000);
    assert.equal(result.signal, null, `${testCase.name}: shutdown must not require termination`);
    assert.equal(
      result.code,
      0,
      `${testCase.name}: shutdown must exit successfully\n${formatOutput(stdout, stderr)}`,
    );
    assert.match(stdout, /Workbridge listening/, `${testCase.name}: startup log must be emitted`);
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill();
      await waitForExit(child, 5_000).catch(() => undefined);
    }
    rmSync(root, { recursive: true, force: true });
  }
}

async function reservePort() {
  const server = createNetServer();
  await new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  await new Promise((resolveClose, rejectClose) => {
    server.close((error) => error ? rejectClose(error) : resolveClose());
  });
  return address.port;
}

async function waitForHealth(child, url, output) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      const current = output();
      throw new Error(`CLI exited before /healthz became ready\n${formatOutput(current.stdout, current.stderr)}`);
    }
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1_000) });
      if (response.status === 200) return await response.json();
    } catch {
      // The child may still be binding the port.
    }
    await delay(100);
  }
  const current = output();
  throw new Error(`Timed out waiting for ${url}\n${formatOutput(current.stdout, current.stderr)}`);
}

function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolveExit, rejectExit) => {
    const timeout = setTimeout(() => {
      cleanup();
      rejectExit(new Error(`Timed out waiting for child process ${child.pid} to exit`));
    }, timeoutMs);
    const onExit = (code, signal) => {
      cleanup();
      resolveExit({ code, signal });
    };
    const cleanup = () => {
      clearTimeout(timeout);
      child.removeListener("exit", onExit);
    };
    child.once("exit", onExit);
  });
}

function formatOutput(stdout, stderr) {
  return `stdout:\n${stdout || "<empty>"}\nstderr:\n${stderr || "<empty>"}`;
}

function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}
