import assert from "node:assert/strict";
import test from "node:test";
import { ModernMcpRequestMetrics } from "./mcp-modern-metrics.js";

test("modern request metrics expose bounded request outcomes and recent clients", () => {
  let now = Date.parse("2026-08-11T00:00:00.000Z");
  const metrics = new ModernMcpRequestMetrics(() => now);
  const listRequest = metrics.begin({
    requestId: "request-list",
    method: "tools/list",
    clientName: "openai-mcp",
    clientVersion: "1.2.3",
    protocolVersion: "2026-07-28",
  });
  now += 25;
  metrics.finish(listRequest, true);
  const callRequest = metrics.begin({
    requestId: "request-call",
    method: "tools/call",
    tool: "open_workspace",
    clientName: "codex",
    protocolVersion: "2026-07-28",
  });
  metrics.recordTimings(callRequest, {
    authMs: 1.25,
    classifyMs: 0.5,
    registrationMs: 4.75,
    handlerMs: 7.5,
    totalMs: 10.25,
  });

  assert.deepEqual(metrics.snapshot(1), {
    stats: {
      requests: 2,
      requestsTotal: 2,
      active: 1,
      activeRequests: 1,
      peakActiveRequests: 1,
      activeRegistrations: 0,
      peakActiveRegistrations: 0,
      activeHandlers: 0,
      peakActiveHandlers: 0,
      requestsCompleted: 1,
      toolsList: 1,
      toolsCall: 1,
      success: 1,
      error: 0,
    },
    phaseTimings: {
      authMs: { count: 0 },
      classifyMs: { count: 0 },
      registrationMs: { count: 0 },
      handlerMs: { count: 0 },
      totalMs: { count: 0 },
    },
    recent: [{
      requestId: "request-call",
      method: "tools/call",
      tool: "open_workspace",
      clientName: "codex",
      protocolVersion: "2026-07-28",
      timings: {
        authMs: 1.25,
        classifyMs: 0.5,
        registrationMs: 4.75,
        handlerMs: 7.5,
        totalMs: 10.25,
      },
      status: "running",
      startedAt: "2026-08-11T00:00:00.025Z",
      durationMs: 0,
      concurrencyAtStart: 1,
      peakConcurrencyDuringRequest: 1,
      overlapped: false,
    }],
  });

  now += 10;
  metrics.finish(callRequest, false);
  const finished = metrics.snapshot(8);
  assert.equal(finished.stats.active, 0);
  assert.equal(finished.stats.error, 1);
  assert.equal(finished.recent[0]?.durationMs, 10);
  assert.equal(finished.recent[0]?.timings?.registrationMs, 4.75);
  assert.equal(finished.recent[1]?.clientVersion, "1.2.3");
});

test("modern request metrics expose overlap and phase lifecycle counters", () => {
  const metrics = new ModernMcpRequestMetrics(() => 0);
  const first = metrics.begin({ method: "tools/call", tool: "read" });
  assert.deepEqual(metrics.snapshot().stats, {
    requests: 1,
    requestsTotal: 1,
    active: 1,
    activeRequests: 1,
    peakActiveRequests: 1,
    activeRegistrations: 0,
    peakActiveRegistrations: 0,
    activeHandlers: 0,
    peakActiveHandlers: 0,
    requestsCompleted: 0,
    toolsList: 0,
    toolsCall: 1,
    success: 0,
    error: 0,
  });
  assert.deepEqual(metrics.snapshot().recent[0], {
    method: "tools/call",
    tool: "read",
    status: "running",
    startedAt: "1970-01-01T00:00:00.000Z",
    durationMs: 0,
    concurrencyAtStart: 1,
    peakConcurrencyDuringRequest: 1,
    overlapped: false,
  });

  metrics.beginRegistration(first);
  metrics.beginHandler(first);
  assert.equal(metrics.snapshot().stats.activeRegistrations, 1);
  assert.equal(metrics.snapshot().stats.activeHandlers, 1);

  const second = metrics.begin({ method: "tools/list" });
  const overlapping = metrics.snapshot();
  assert.equal(overlapping.stats.activeRequests, 2);
  assert.equal(overlapping.stats.peakActiveRequests, 2);
  assert.equal(overlapping.recent.find((request) => request.method === "tools/call")?.peakConcurrencyDuringRequest, 2);
  assert.equal(overlapping.recent.find((request) => request.method === "tools/call")?.overlapped, true);
  assert.equal(overlapping.recent.find((request) => request.method === "tools/list")?.concurrencyAtStart, 2);
  assert.equal(overlapping.recent.find((request) => request.method === "tools/list")?.peakConcurrencyDuringRequest, 2);
  assert.equal(overlapping.recent.find((request) => request.method === "tools/list")?.overlapped, true);

  metrics.endHandler(first);
  metrics.endRegistration(first);
  metrics.finish(first, true);
  metrics.finish(second, false);
  assert.equal(metrics.snapshot().stats.activeRequests, 0);
  assert.equal(metrics.snapshot().stats.requestsCompleted, 2);
  assert.equal(metrics.snapshot().stats.success + metrics.snapshot().stats.error, 2);
  assert.equal(metrics.snapshot().stats.activeHandlers, 0);
  assert.equal(metrics.snapshot().stats.activeRegistrations, 0);
});

test("modern request phase counters are idempotent when error cleanup runs in finally", () => {
  const metrics = new ModernMcpRequestMetrics(() => 0);
  const reference = metrics.begin({ method: "tools/call", tool: "read" });
  try {
    metrics.beginRegistration(reference);
    metrics.beginHandler(reference);
    throw new Error("handler failed");
  } catch (error) {
    assert.equal((error as Error).message, "handler failed");
  } finally {
    metrics.endHandler(reference);
    metrics.endRegistration(reference);
    metrics.finish(reference, false);
  }
  metrics.endHandler(reference);
  metrics.endRegistration(reference);
  assert.equal(metrics.snapshot().stats.activeRequests, 0);
  assert.equal(metrics.snapshot().stats.activeRegistrations, 0);
  assert.equal(metrics.snapshot().stats.activeHandlers, 0);
  assert.equal(metrics.snapshot().stats.requestsCompleted, 1);
});
