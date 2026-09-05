"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  MEMORY_LOG_SCHEMA,
  MemoryHistoryLogger,
  createMemoryLogRecord,
  normalizeProcessRole,
  utcDateKey,
} = require("./memory-log.cjs");

const runtime = {
  monitorVersion: "1.1.0",
  frameworkVersion: "43.2.0",
  webRuntimeVersion: "136.0.0",
  platform: "win32",
  arch: "x64",
  hostPid: 101,
};

function candidate(overrides = {}) {
  return {
    desktopMemory: {
      workingSetBytes: 400,
      privateBytes: 300,
      peakWorkingSetBytes: 450,
      processes: [
        { pid: 101, type: "Browser", workingSetBytes: 250, privateBytes: 190 },
        { pid: 102, type: "Tab", workingSetBytes: 150, privateBytes: 110 },
      ],
      system: { totalBytes: 10_000, freeBytes: 2_000, usedBytes: 8_000 },
    },
    runtimeStatus: {
      server: {
        pid: 201,
        memory: { rssBytes: 700, heapUsedBytes: 350 },
        buildIdentity: {
          branch: "workbridge-fixed-surface",
          commit: "abc123",
          dirty: false,
          sourceRoot: "C:\\secret\\source-root",
        },
        startupConfig: { stateDir: "C:\\secret\\state" },
      },
      mcpSessions: { stats: { activeRequests: 2 }, recent: [{ title: "SECRET_SESSION_TITLE" }] },
      modernMcpRequests: {
        stats: { requests: 12, active: 3, peakActiveRequests: 7 },
        phaseTimings: {
          registrationMs: { count: 12, p50: 2.1, p95: 3.2, p99: 4.3 },
          handlerMs: { count: 12, p50: 20.1, p95: 30.2, p99: 40.3 },
          totalMs: { count: 12, p50: 22.1, p95: 33.2, p99: 44.3 },
        },
        recent: [{ requestId: "SECRET_REQUEST_ID", tool: "SECRET_TOOL" }],
      },
      nodeSaturation: {
        eventLoopUtilization: 0.42,
        eventLoopDelayP50Ms: 10.1,
        eventLoopDelayP95Ms: 20.2,
        eventLoopDelayP99Ms: 30.3,
        sampleWindowMs: 1_000,
        debug: "SECRET_SATURATION",
      },
      prompt: "SECRET_PROMPT",
      response: "SECRET_RESPONSE",
      auth: "SECRET_AUTH",
    },
    serverReachable: true,
    ...overrides,
  };
}

assert.equal(MEMORY_LOG_SCHEMA, "workbridge.monitor.memory.v1");
assert.equal(utcDateKey(Date.parse("2026-08-24T23:59:59.000Z")), "2026-08-24");
assert.equal(normalizeProcessRole("Browser"), "browser");
assert.equal(normalizeProcessRole("Tab"), "renderer");
assert.equal(normalizeProcessRole("GPU"), "gpu");
assert.equal(normalizeProcessRole("Utility"), "utility");
assert.equal(normalizeProcessRole("Future Type"), "future-type");

const normalized = createMemoryLogRecord({
  ...candidate(),
  shell: "electron",
  runtime,
  capturedAtMs: Date.parse("2026-08-24T04:00:00.000Z"),
});
assert.equal(normalized.schema, MEMORY_LOG_SCHEMA);
assert.equal(normalized.runtime.shell, "electron");
assert.equal(normalized.runtime.hostPid, 101);
assert.equal(normalized.desktop.processes[0].role, "browser");
assert.equal(normalized.desktop.processes[1].role, "renderer");
assert.equal(normalized.workload.modernMcpRequests, 12);
assert.equal(normalized.workload.activeRequests, 5);
assert.deepEqual(normalized.modernMcp, {
  requests: 12,
  active: 3,
  peakActiveRequests: 7,
  registrationMs: { count: 12, p50: 2.1, p95: 3.2, p99: 4.3 },
  handlerMs: { count: 12, p50: 20.1, p95: 30.2, p99: 40.3 },
  totalMs: { count: 12, p50: 22.1, p95: 33.2, p99: 44.3 },
});
assert.deepEqual(normalized.nodeSaturation, {
  eventLoopUtilization: 0.42,
  eventLoopDelayP50Ms: 10.1,
  eventLoopDelayP95Ms: 20.2,
  eventLoopDelayP99Ms: 30.3,
  sampleWindowMs: 1_000,
});
assert.equal(normalized.quality.desktopComplete, true);
assert.equal(normalized.quality.serverReachable, true);
const normalizedJson = JSON.stringify(normalized);
for (const forbidden of [
  "SECRET_PROMPT",
  "SECRET_RESPONSE",
  "SECRET_AUTH",
  "SECRET_SESSION_TITLE",
  "SECRET_REQUEST_ID",
  "SECRET_TOOL",
  "SECRET_SATURATION",
  "secret\\\\source-root",
  "secret\\\\state",
]) {
  assert.equal(normalizedJson.includes(forbidden), false, `must not persist ${forbidden}`);
}
assert.equal(Object.hasOwn(normalized.runtime, "sourceRoot"), false);
assert.equal(Object.hasOwn(normalized.workload, "stateDir"), false);

void (async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "workbridge-memory-log-test-"));
  const logger = new MemoryHistoryLogger({
    stateDir: root,
    shell: "electron",
    runtime,
  });
  const firstAt = Date.parse("2026-08-24T23:59:40.000Z");
  const secondAt = firstAt + 29_999;
  const thirdAt = firstAt + 30_000;
  assert.equal(await logger.record(candidate(), firstAt), true);
  assert.equal(await logger.record(candidate(), secondAt), false);
  assert.equal(await logger.record(candidate(), thirdAt), true);
  await logger.flush();
  const directory = path.join(root, "monitor-memory", "electron");
  const firstFile = path.join(directory, "2026-08-24.jsonl");
  const nextFile = path.join(directory, "2026-08-25.jsonl");
  assert.equal(fs.existsSync(firstFile), true);
  assert.equal(fs.existsSync(nextFile), true);
  const firstLines = fs.readFileSync(firstFile, "utf8").trim().split("\n");
  const nextLines = fs.readFileSync(nextFile, "utf8").trim().split("\n");
  assert.equal(firstLines.length, 1);
  assert.equal(nextLines.length, 1);
  assert.equal(JSON.parse(firstLines[0]).capturedAt, "2026-08-24T23:59:40.000Z");
  assert.equal(JSON.parse(nextLines[0]).capturedAt, "2026-08-25T00:00:10.000Z");
  assert.equal(logger.status().lastWrittenAt, "2026-08-25T00:00:10.000Z");
  assert.equal(logger.status().lastError, null);
  assert.equal(logger.status().intervalMs, 30_000);
  assert.equal(logger.status().retentionDays, 30);

  const orderedRoot = fs.mkdtempSync(path.join(os.tmpdir(), "workbridge-memory-order-test-"));
  const ordered = new MemoryHistoryLogger({
    stateDir: orderedRoot,
    shell: "electron",
    runtime,
    intervalMs: 0,
  });
  const orderAt = Date.parse("2026-08-24T04:00:00.000Z");
  const writeOne = ordered.record(candidate(), orderAt);
  const writeTwo = ordered.record(candidate(), orderAt + 1);
  assert.deepEqual(await Promise.all([writeOne, writeTwo]), [true, true]);
  await ordered.flush();
  const orderedFile = path.join(orderedRoot, "monitor-memory", "electron", "2026-08-24.jsonl");
  const orderedLines = fs.readFileSync(orderedFile, "utf8").trim().split("\n").map(JSON.parse);
  assert.deepEqual(
    orderedLines.map((entry) => entry.capturedAt),
    ["2026-08-24T04:00:00.000Z", "2026-08-24T04:00:00.001Z"],
  );

  const retentionRoot = fs.mkdtempSync(path.join(os.tmpdir(), "workbridge-memory-retention-test-"));
  const retentionDirectory = path.join(retentionRoot, "monitor-memory", "electron");
  fs.mkdirSync(retentionDirectory, { recursive: true });
  for (const name of [
    "2026-07-20.jsonl",
    "2026-07-26.jsonl",
    "2026-08-24.jsonl",
    "note.txt",
    "not-a-date.jsonl",
  ]) {
    fs.writeFileSync(path.join(retentionDirectory, name), `${name}\n`);
  }
  const retention = new MemoryHistoryLogger({ stateDir: retentionRoot, runtime });
  assert.equal(await retention.cleanupIfDue(Date.parse("2026-08-24T12:00:00.000Z")), null);
  assert.equal(fs.existsSync(path.join(retentionDirectory, "2026-07-20.jsonl")), false);
  assert.equal(fs.existsSync(path.join(retentionDirectory, "2026-07-26.jsonl")), true);
  assert.equal(fs.existsSync(path.join(retentionDirectory, "2026-08-24.jsonl")), true);
  assert.equal(fs.existsSync(path.join(retentionDirectory, "note.txt")), true);
  assert.equal(fs.existsSync(path.join(retentionDirectory, "not-a-date.jsonl")), true);

  const badRootParent = fs.mkdtempSync(path.join(os.tmpdir(), "workbridge-memory-error-test-"));
  const badRoot = path.join(badRootParent, "not-a-directory");
  fs.writeFileSync(badRoot, "blocking file");
  const failing = new MemoryHistoryLogger({ stateDir: badRoot, runtime });
  const cleanupError = await failing.cleanupIfDue(Date.parse("2026-08-24T12:00:00.000Z"));
  assert.match(cleanupError, /^cleanup:/);
  assert.equal(await failing.record(candidate(), Date.parse("2026-08-24T12:00:00.000Z")), false);
  assert.match(failing.status().lastError, /^append:/);

  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(orderedRoot, { recursive: true, force: true });
  fs.rmSync(retentionRoot, { recursive: true, force: true });
  fs.rmSync(badRootParent, { recursive: true, force: true });
  console.log("memory-log.test.cjs: PASS");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
