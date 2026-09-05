import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createNetServer } from "node:net";
import { performance } from "node:perf_hooks";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = join(repositoryRoot, "dist", "cli.js");
const DEFAULT_CONCURRENCIES = [1, 2, 4, 8, 16, 32];
const DEFAULT_ITERATIONS = 20;
const DEFAULT_MIN_DURATION_MS = 2_250;
const REQUEST_TIMEOUT_MS = 10_000;

const options = parseArguments(process.argv.slice(2));
if (options.help) {
  console.log([
    "Usage: node scripts/benchmark-modern-mcp-concurrency.mjs [options]",
    "  --mode tools/list|read|both     Benchmark mode (default: both)",
    "  --concurrency 1,2,4             Concurrency levels (default: 1,2,4,8,16,32)",
    "  --iterations 20                 Rounds per concurrency (default: 20)",
    "  --min-duration-ms 2250          Minimum measured duration (default: 2250)",
  ].join("\n"));
  process.exit(0);
}
if (!existsSync(cliPath)) {
  throw new Error(`Missing ${cliPath}. Run npm run build before the benchmark.`);
}

for (const mode of options.modes) {
  for (const concurrency of options.concurrencies) {
    const result = await runCase(mode, concurrency, options.iterations, options.minDurationMs);
    console.log(JSON.stringify(result));
  }
}

async function runCase(mode, concurrency, iterations, minDurationMs) {
  const root = mkdtempSync(join(tmpdir(), "workbridge-modern-mcp-benchmark-"));
  const configDir = join(root, "config");
  const stateDir = join(root, "state");
  const projectRoot = join(root, "project");
  mkdirSync(configDir, { recursive: true });
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(projectRoot, { recursive: true });
  writeFileSync(join(projectRoot, "benchmark-read.txt"), "workbridge modern MCP benchmark\n", "utf8");

  let port = await reservePort();
  let monitorPort = await reservePort(port);
  let baseUrl = `http://127.0.0.1:${port}`;
  let monitorUrl = `http://127.0.0.1:${monitorPort}`;
  const childEnvironment = {
    ...process.env,
    HOST: "127.0.0.1",
    PORT: String(port),
    WORKBRIDGE_MONITOR_PORT: String(monitorPort),
    DEVSPACE_CONFIG_DIR: configDir,
    DEVSPACE_STATE_DIR: stateDir,
    DEVSPACE_ALLOWED_ROOTS: projectRoot,
    DEVSPACE_WORKTREE_ROOT: join(projectRoot, ".workbridge", "worktrees"),
    DEVSPACE_PUBLIC_BASE_URL: baseUrl,
    WORKBRIDGE_MCP_CONNECTION_MODE: "openai-secure-mcp-tunnel",
    DEVSPACE_OAUTH_OWNER_TOKEN: "benchmark-owner-token-that-is-long-enough",
    DEVSPACE_LOG_LEVEL: "silent",
    DEVSPACE_LOG_FILE: "0",
    DEVSPACE_LOG_REQUESTS: "0",
    DEVSPACE_LOG_TOOL_CALLS: "0",
  };
  let output = { stdout: "", stderr: "" };
  let child = spawnBenchmarkChild(childEnvironment, output);

  try {
    await waitForHealth(child, `${baseUrl}/healthz`, () => output);
    let workspaceId;
    if (mode === "read") {
      const opened = await postModern(baseUrl, "tools/call", {
        name: "open_workspace",
        arguments: { path: projectRoot },
      });
      workspaceId = opened.result?.structuredContent?.workspaceId;
      assert.equal(typeof workspaceId, "string", JSON.stringify(opened));
      await stopChild(child);
      port = await reservePort();
      monitorPort = await reservePort(port);
      baseUrl = `http://127.0.0.1:${port}`;
      monitorUrl = `http://127.0.0.1:${monitorPort}`;
      childEnvironment.PORT = String(port);
      childEnvironment.WORKBRIDGE_MONITOR_PORT = String(monitorPort);
      childEnvironment.DEVSPACE_PUBLIC_BASE_URL = baseUrl;
      output = { stdout: "", stderr: "" };
      child = spawnBenchmarkChild(childEnvironment, output);
      await waitForHealth(child, `${baseUrl}/healthz`, () => output);
    }

    const before = await waitForSaturationSample(child, monitorUrl, () => output);
    const saturationSamples = [];
    let lastSampledAt = before.nodeSaturation?.sampledAt;
    let polling = false;
    const poller = setInterval(async () => {
      if (polling) return;
      polling = true;
      try {
        const sample = (await getStatus(monitorUrl)).nodeSaturation;
        if (sample?.sampledAt && sample.sampledAt !== lastSampledAt) {
          saturationSamples.push(sample);
          lastSampledAt = sample.sampledAt;
        }
      } catch {
        // The child remains the benchmark authority; a transient poll is ignored.
      } finally {
        polling = false;
      }
    }, 50);
    poller.unref();

    const clientSamples = [];
    const startedAt = performance.now();
    let rounds = 0;
    const measuredDurationMs = Math.max(
      minDurationMs,
      (before.nodeSaturation?.sampleWindowMs ?? 1_000) * 2 + 250,
    );
    try {
      do {
        const batch = Array.from({ length: concurrency }, async () => {
          const requestStartedAt = performance.now();
          const response = await postModern(
            baseUrl,
            mode === "read" ? "tools/call" : "tools/list",
            mode === "read"
              ? {
                  name: "read",
                  arguments: { workspaceId, path: "benchmark-read.txt", offset: 1, limit: 32 },
                }
              : {},
          );
          clientSamples.push(performance.now() - requestStartedAt);
          assert.equal(response.httpStatus, 200, JSON.stringify(response));
          assert.equal(response.error, undefined, JSON.stringify(response));
        });
        await Promise.all(batch);
        rounds += 1;
      } while (rounds < iterations || performance.now() - startedAt < measuredDurationMs);
    } finally {
      clearInterval(poller);
    }
    const elapsedMs = performance.now() - startedAt;
    const after = await getStatus(monitorUrl);
    if (after.nodeSaturation?.sampledAt && after.nodeSaturation.sampledAt !== lastSampledAt) {
      saturationSamples.push(after.nodeSaturation);
    }
    assert.ok(saturationSamples.length > 0, "Benchmark did not capture an event-loop saturation sample");
    const modern = after.modernMcpRequests;
    const beforeStats = before.modernMcpRequests.stats;
    const afterStats = modern.stats;
    const completed = afterStats.requestsCompleted - beforeStats.requestsCompleted;
    assert.equal(completed, clientSamples.length);
    for (const phase of ["authMs", "classifyMs", "registrationMs", "handlerMs", "totalMs"]) {
      assert.equal(modern.phaseTimings[phase].count, completed, `${phase} includes requests outside the measured window`);
    }

    return {
      Mode: mode,
      Concurrency: concurrency,
      Rounds: rounds,
      "Requests completed": completed,
      "Throughput req/s": round(completed / Math.max(elapsedMs / 1_000, Number.EPSILON)),
      "Client p50": round(percentile(clientSamples, 0.5)),
      "Client p95": round(percentile(clientSamples, 0.95)),
      "Client p99": round(percentile(clientSamples, 0.99)),
      "Registration p50": round(modern.phaseTimings.registrationMs.p50),
      "Registration p95": round(modern.phaseTimings.registrationMs.p95),
      "Registration p99": round(modern.phaseTimings.registrationMs.p99),
      "Handler p50": round(modern.phaseTimings.handlerMs.p50),
      "Handler p95": round(modern.phaseTimings.handlerMs.p95),
      "Handler p99": round(modern.phaseTimings.handlerMs.p99),
      "Server total p50": round(modern.phaseTimings.totalMs.p50),
      "Server total p95": round(modern.phaseTimings.totalMs.p95),
      "Server total p99": round(modern.phaseTimings.totalMs.p99),
      "Peak active requests": afterStats.peakActiveRequests,
      "Peak active handlers": afterStats.peakActiveHandlers,
      "Peak active registrations": afterStats.peakActiveRegistrations,
      "ELU avg": round(average(saturationSamples.map((sample) => sample?.eventLoopUtilization))),
      "ELU peak": round(Math.max(0, ...saturationSamples.map((sample) => sample?.eventLoopUtilization ?? 0))),
      "Saturation samples": saturationSamples.length,
      "Loop delay p95": round(Math.max(0, ...saturationSamples.map((sample) => sample?.eventLoopDelayP95Ms ?? 0))),
      "Loop delay p99": round(Math.max(0, ...saturationSamples.map((sample) => sample?.eventLoopDelayP99Ms ?? 0))),
    };
  } finally {
    await stopChild(child).catch(() => undefined);
    rmSync(root, { recursive: true, force: true });
  }
}

function spawnBenchmarkChild(environment, output) {
  const child = spawn(process.execPath, [cliPath, "serve"], {
    cwd: repositoryRoot,
    env: environment,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { output.stdout += chunk; });
  child.stderr.on("data", (chunk) => { output.stderr += chunk; });
  return child;
}

async function stopChild(child) {
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
  await waitForExit(child, 15_000);
}

function parseArguments(args) {
  const values = new Map();
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (value === "--help") return { help: true };
    if (!value?.startsWith("--")) throw new Error(`Unknown argument: ${value}`);
    const [name, inline] = value.split("=", 2);
    const next = inline ?? args[++index];
    if (!next || next.startsWith("--")) throw new Error(`Missing value for ${name}`);
    values.set(name, next);
  }
  const mode = values.get("--mode") ?? "both";
  if (!["tools/list", "read", "both"].includes(mode)) throw new Error(`Invalid --mode: ${mode}`);
  const concurrencies = parsePositiveList(values.get("--concurrency"), DEFAULT_CONCURRENCIES);
  const iterations = parsePositiveInteger(values.get("--iterations"), DEFAULT_ITERATIONS);
  const minDurationMs = parsePositiveInteger(values.get("--min-duration-ms"), DEFAULT_MIN_DURATION_MS);
  return {
    help: false,
    modes: mode === "both" ? ["tools/list", "read"] : [mode],
    concurrencies,
    iterations,
    minDurationMs,
  };
}

function parsePositiveList(value, fallback) {
  if (value === undefined) return fallback;
  const parsed = value.split(",").map((item) => Number(item.trim()));
  if (parsed.length === 0 || parsed.some((item) => !Number.isInteger(item) || item < 1)) {
    throw new Error(`Invalid --concurrency: ${value}`);
  }
  return parsed;
}

function parsePositiveInteger(value, fallback) {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`Invalid integer: ${value}`);
  return parsed;
}

async function postModern(baseUrl, method, params) {
  const response = await fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "mcp-method": method,
      "mcp-protocol-version": "2026-07-28",
      ...(typeof params.name === "string" ? { "mcp-name": params.name } : {}),
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: `benchmark-${method}-${Date.now()}-${Math.random()}`,
      method,
      params: {
        ...params,
        _meta: {
          ...objectValue(params._meta),
          "io.modelcontextprotocol/protocolVersion": "2026-07-28",
          "io.modelcontextprotocol/clientCapabilities": {},
          "io.modelcontextprotocol/clientInfo": {
            name: "workbridge-modern-mcp-concurrency-benchmark",
            version: "1.0.0",
          },
        },
      },
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const body = await response.json();
  return { ...body, httpStatus: response.status };
}

async function getStatus(monitorUrl) {
  const response = await fetch(`${monitorUrl}/monitor/api/status`, {
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  assert.equal(response.status, 200);
  return response.json();
}

async function waitForSaturationSample(child, monitorUrl, output) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      const current = output();
      throw new Error(`Benchmark child exited before saturation sampling\n${formatOutput(current.stdout, current.stderr)}`);
    }
    try {
      const status = await getStatus(monitorUrl);
      if (status.nodeSaturation?.sampledAt) return status;
    } catch {
      // The first one-second saturation sample may not exist yet.
    }
    await delay(25);
  }
  throw new Error("Timed out waiting for the first event-loop saturation sample");
}

async function reservePort(otherPort) {
  const server = createNetServer();
  await new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const port = address.port;
  await new Promise((resolveClose, rejectClose) => {
    server.close((error) => error ? rejectClose(error) : resolveClose());
  });
  return port === otherPort ? reservePort(otherPort) : port;
}

async function waitForHealth(child, url, output) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      const current = output();
      throw new Error(`Benchmark child exited before health check\n${formatOutput(current.stdout, current.stderr)}`);
    }
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1_000) });
      if (response.status === 200) return;
    } catch {
      // The child may still be binding its isolated loopback ports.
    }
    await delay(100);
  }
  const current = output();
  throw new Error(`Timed out waiting for ${url}\n${formatOutput(current.stdout, current.stderr)}`);
}

function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolveExit, rejectExit) => {
    const timeout = setTimeout(() => {
      child.removeListener("exit", onExit);
      rejectExit(new Error(`Timed out waiting for benchmark child ${child.pid}`));
    }, timeoutMs);
    const onExit = () => {
      clearTimeout(timeout);
      resolveExit();
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

function objectValue(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function percentile(values, fraction) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)] ?? 0;
}

function average(values) {
  const finite = values.filter((value) => Number.isFinite(value));
  return finite.length === 0 ? 0 : finite.reduce((sum, value) => sum + value, 0) / finite.length;
}

function round(value) {
  return Number.isFinite(value) ? Number(value.toFixed(3)) : 0;
}
