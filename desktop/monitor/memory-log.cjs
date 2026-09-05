"use strict";

const fs = require("node:fs");
const path = require("node:path");

const MEMORY_LOG_SCHEMA = "workbridge.monitor.memory.v1";
const DEFAULT_MEMORY_LOG_INTERVAL_MS = 30_000;
const DEFAULT_MEMORY_LOG_RETENTION_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;
const DAILY_FILE_RE = /^\d{4}-\d{2}-\d{2}\.jsonl$/;

class MemoryHistoryLogger {
  constructor(options = {}) {
    this.shell = options.shell || "electron";
    this.runtime = options.runtime || {};
    this.intervalMs = options.intervalMs ?? DEFAULT_MEMORY_LOG_INTERVAL_MS;
    this.retentionDays = options.retentionDays ?? DEFAULT_MEMORY_LOG_RETENTION_DAYS;
    this.queue = Promise.resolve(false);
    this.lastAttemptAt = 0;
    this.lastWrittenAt = null;
    this.lastError = null;
    this.lastCleanupDate = null;
    this.setStateDir(options.stateDir);
  }

  setStateDir(stateDir) {
    this.stateDir = typeof stateDir === "string" && stateDir.trim()
      ? path.resolve(stateDir.trim())
      : undefined;
    this.directory = this.stateDir
      ? path.join(this.stateDir, "monitor-memory", this.shell)
      : undefined;
    this.lastAttemptAt = 0;
    this.lastCleanupDate = null;
  }

  status() {
    return {
      enabled: Boolean(this.directory),
      intervalMs: this.intervalMs,
      retentionDays: this.retentionDays,
      directory: this.directory,
      lastWrittenAt: this.lastWrittenAt,
      lastError: this.lastError,
    };
  }

  record(candidate, capturedAtMs = Date.now()) {
    if (!this.directory || !candidate?.desktopMemory) return Promise.resolve(false);
    if (!Number.isFinite(capturedAtMs)) capturedAtMs = Date.now();
    if (this.lastAttemptAt && capturedAtMs - this.lastAttemptAt < this.intervalMs) {
      return Promise.resolve(false);
    }
    this.lastAttemptAt = capturedAtMs;
    const record = createMemoryLogRecord({
      ...candidate,
      shell: this.shell,
      runtime: this.runtime,
      capturedAtMs,
    });
    this.queue = this.queue.then(async () => {
      const cleanupError = await this.cleanupIfDue(capturedAtMs);
      const file = path.join(this.directory, `${utcDateKey(capturedAtMs)}.jsonl`);
      try {
        await fs.promises.mkdir(this.directory, { recursive: true });
        await fs.promises.appendFile(file, `${JSON.stringify(record)}\n`, "utf8");
        this.lastWrittenAt = record.capturedAt;
        this.lastError = cleanupError;
        return true;
      } catch (error) {
        this.lastError = `append: ${errorMessage(error)}`;
        return false;
      }
    });
    return this.queue;
  }

  async cleanupIfDue(nowMs = Date.now()) {
    if (!this.directory) return null;
    const today = utcDateKey(nowMs);
    if (this.lastCleanupDate === today) return null;
    this.lastCleanupDate = today;
    try {
      await fs.promises.mkdir(this.directory, { recursive: true });
      const entries = await fs.promises.readdir(this.directory, { withFileTypes: true });
      const cutoffMs = Date.parse(`${today}T00:00:00.000Z`)
        - Math.max(0, this.retentionDays - 1) * DAY_MS;
      const cutoff = utcDateKey(cutoffMs);
      await Promise.all(entries
        .filter((entry) => entry.isFile() && DAILY_FILE_RE.test(entry.name))
        .filter((entry) => entry.name.slice(0, 10) < cutoff)
        .map((entry) => fs.promises.rm(path.join(this.directory, entry.name), { force: true })));
      return null;
    } catch (error) {
      return `cleanup: ${errorMessage(error)}`;
    }
  }

  flush() {
    return this.queue;
  }
}

function createMemoryLogRecord(candidate) {
  const desktop = candidate.desktopMemory || {};
  const server = candidate.runtimeStatus?.server || {};
  const build = server.buildIdentity || {};
  const serverMemory = server.memory || {};
  const legacyStats = candidate.runtimeStatus?.mcpSessions?.stats || {};
  const modern = candidate.runtimeStatus?.modernMcpRequests || {};
  const modernStats = modern.stats || {};
  const modernTimings = modern.phaseTimings || {};
  const nodeSaturation = candidate.runtimeStatus?.nodeSaturation || {};
  const processes = Array.isArray(desktop.processes)
    ? desktop.processes.map((process) => ({
      pid: safePid(process?.pid),
      role: normalizeProcessRole(process?.type),
      workingSetBytes: safeBytes(process?.workingSetBytes),
      privateBytes: safeBytes(process?.privateBytes),
    }))
    : [];
  const system = desktop.system || {};
  const desktopRecord = {
    workingSetBytes: safeBytes(desktop.workingSetBytes),
    privateBytes: safeBytes(desktop.privateBytes),
    peakWorkingSetBytes: safeBytes(desktop.peakWorkingSetBytes),
    processes,
  };
  const systemRecord = {
    totalBytes: safeBytes(system.totalBytes),
    freeBytes: safeBytes(system.freeBytes),
    usedBytes: safeBytes(system.usedBytes),
  };
  const capturedAtMs = Number.isFinite(candidate.capturedAtMs)
    ? candidate.capturedAtMs
    : Date.now();
  return {
    schema: MEMORY_LOG_SCHEMA,
    capturedAt: new Date(capturedAtMs).toISOString(),
    runtime: normalizeRuntime(candidate.shell, candidate.runtime),
    desktop: desktopRecord,
    server: {
      pid: safePid(server.pid),
      rssBytes: safeBytes(serverMemory.rssBytes),
      heapUsedBytes: safeBytes(serverMemory.heapUsedBytes),
    },
    system: systemRecord,
    workload: {
      branch: safeText(build.branch),
      commit: safeText(build.commit),
      dirty: typeof build.dirty === "boolean" ? build.dirty : null,
      modernMcpRequests: safeCounter(modernStats.requests),
      activeRequests: safeCounter(legacyStats.activeRequests) + safeCounter(modernStats.active),
    },
    modernMcp: {
      requests: safeCounter(modernStats.requests),
      active: safeCounter(modernStats.active),
      peakActiveRequests: safeCounter(modernStats.peakActiveRequests),
      registrationMs: timingSummary(modernTimings.registrationMs),
      handlerMs: timingSummary(modernTimings.handlerMs),
      totalMs: timingSummary(modernTimings.totalMs),
    },
    nodeSaturation: {
      eventLoopUtilization: safeMetric(nodeSaturation.eventLoopUtilization),
      eventLoopDelayP50Ms: safeMetric(nodeSaturation.eventLoopDelayP50Ms),
      eventLoopDelayP95Ms: safeMetric(nodeSaturation.eventLoopDelayP95Ms),
      eventLoopDelayP99Ms: safeMetric(nodeSaturation.eventLoopDelayP99Ms),
      sampleWindowMs: safeMetric(nodeSaturation.sampleWindowMs),
    },
    quality: {
      desktopComplete: desktopSampleComplete(desktopRecord, systemRecord),
      serverReachable: Boolean(candidate.serverReachable && candidate.runtimeStatus?.server),
    },
  };
}

function normalizeRuntime(shell, runtime = {}) {
  return {
    shell: safeText(shell) || "unknown",
    monitorVersion: safeText(runtime.monitorVersion),
    frameworkVersion: safeText(runtime.frameworkVersion),
    webRuntimeVersion: safeText(runtime.webRuntimeVersion),
    platform: safeText(runtime.platform),
    arch: safeText(runtime.arch),
    hostPid: safePid(runtime.hostPid),
  };
}

function normalizeProcessRole(type) {
  const value = safeText(type) || "unknown";
  if (value === "Browser") return "browser";
  if (value === "Tab") return "renderer";
  if (value === "GPU") return "gpu";
  if (value === "Utility") return "utility";
  return value.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "unknown";
}

function desktopSampleComplete(desktop, system) {
  const desktopNumbers = [
    desktop.workingSetBytes,
    desktop.privateBytes,
    desktop.peakWorkingSetBytes,
    system.totalBytes,
    system.freeBytes,
    system.usedBytes,
  ];
  return desktopNumbers.every(Number.isFinite)
    && desktop.processes.length > 0
    && desktop.processes.every((process) => Number.isInteger(process.pid)
      && Number.isFinite(process.workingSetBytes)
      && Number.isFinite(process.privateBytes));
}

function safeBytes(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.round(value)
    : null;
}
function safePid(value) {
  return Number.isInteger(value) && value >= 0 ? value : null;
}

function safeCounter(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.round(value)
    : 0;
}

function safeMetric(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function timingSummary(value = {}) {
  return {
    count: safeCounter(value.count),
    p50: safeMetric(value.p50),
    p95: safeMetric(value.p95),
    p99: safeMetric(value.p99),
  };
}

function safeText(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function utcDateKey(value) {
  return new Date(value).toISOString().slice(0, 10);
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

module.exports = {
  DEFAULT_MEMORY_LOG_INTERVAL_MS,
  DEFAULT_MEMORY_LOG_RETENTION_DAYS,
  MEMORY_LOG_SCHEMA,
  MemoryHistoryLogger,
  createMemoryLogRecord,
  normalizeProcessRole,
  utcDateKey,
};
