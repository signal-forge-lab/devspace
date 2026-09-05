import assert from "node:assert/strict";
import test from "node:test";
import {
  NodeSaturationMetrics,
  eventLoopDelayNanosecondsToMilliseconds,
} from "./node-saturation-metrics.js";

test("event loop delay conversion clamps invalid values and converts nanoseconds", () => {
  assert.equal(eventLoopDelayNanosecondsToMilliseconds(12_500_000), 12.5);
  assert.equal(eventLoopDelayNanosecondsToMilliseconds(-1), 0);
  assert.equal(eventLoopDelayNanosecondsToMilliseconds(Number.NaN), 0);
});

test("node saturation metrics sample and close without real-time waits", () => {
  let now = Date.parse("2026-08-28T00:00:00.000Z");
  const intervals: Array<() => void> = [];
  let cleared = false;
  let unrefCalled = false;
  let enabled = 0;
  let disabled = 0;
  const readings = [
    { active: 10, idle: 90, utilization: 0.1 },
    { active: 30, idle: 170, utilization: 0.2 },
  ];
  const histogram = {
    enable: () => { enabled += 1; },
    disable: () => { disabled += 1; },
    percentile: (value: number) => ({ 50: 1_000_000, 95: 2_500_000, 99: 4_000_000 }[value] ?? 0),
  };
  const metrics = new NodeSaturationMetrics({
    sampleWindowMs: 1_000,
    now: () => now,
    eventLoopUtilization: () => readings.shift() ?? readings[readings.length - 1]!,
    createHistogram: () => histogram,
    setInterval: (callback) => {
      intervals.push(callback);
      return { unref: () => { unrefCalled = true; } } as unknown as ReturnType<typeof setInterval>;
    },
    clearInterval: () => { cleared = true; },
  });

  assert.deepEqual(metrics.snapshot(), {
    eventLoopUtilization: 0,
    eventLoopDelayP50Ms: 0,
    eventLoopDelayP95Ms: 0,
    eventLoopDelayP99Ms: 0,
    sampleWindowMs: 1_000,
    sampledAt: null,
  });

  metrics.start();
  assert.equal(enabled, 1);
  assert.equal(intervals.length, 1);
  assert.equal(unrefCalled, true);
  now += 1_000;
  intervals[0]!();
  assert.deepEqual(metrics.snapshot(), {
    eventLoopUtilization: 0.2,
    eventLoopDelayP50Ms: 1,
    eventLoopDelayP95Ms: 2.5,
    eventLoopDelayP99Ms: 4,
    sampleWindowMs: 1_000,
    sampledAt: "2026-08-28T00:00:01.000Z",
  });

  metrics.close();
  metrics.close();
  assert.equal(cleared, true);
  assert.equal(disabled, 1);
});
