import {
  monitorEventLoopDelay,
  performance,
} from "node:perf_hooks";

export interface NodeSaturationSnapshot {
  eventLoopUtilization: number;
  eventLoopDelayP50Ms: number;
  eventLoopDelayP95Ms: number;
  eventLoopDelayP99Ms: number;
  sampleWindowMs: number;
  sampledAt: string | null;
}

interface EventLoopUtilizationReading {
  active: number;
  idle: number;
  utilization: number;
}

interface EventLoopDelayHistogram {
  enable(): void;
  disable(): void;
  percentile(percentile: number): number;
  reset?(): void;
}

type IntervalHandle = ReturnType<typeof setInterval>;
type IntervalScheduler = (callback: () => void, delay: number) => IntervalHandle;
type IntervalCanceller = (timer: IntervalHandle) => void;

export interface NodeSaturationMetricsOptions {
  sampleWindowMs?: number;
  resolution?: number;
  now?: () => number;
  eventLoopUtilization?: () => EventLoopUtilizationReading;
  createHistogram?: () => EventLoopDelayHistogram;
  setInterval?: IntervalScheduler;
  clearInterval?: IntervalCanceller;
}

export function eventLoopDelayNanosecondsToMilliseconds(value: number): number {
  return Number.isFinite(value) && value >= 0 ? value / 1_000_000 : 0;
}

export class NodeSaturationMetrics {
  private readonly sampleWindowMs: number;
  private readonly now: () => number;
  private readonly readEventLoopUtilization: () => EventLoopUtilizationReading;
  private readonly histogram: EventLoopDelayHistogram;
  private readonly setInterval: IntervalScheduler;
  private readonly clearInterval: IntervalCanceller;
  private timer: IntervalHandle | undefined;
  private previousUtilization: EventLoopUtilizationReading | undefined;
  private started = false;
  private current: NodeSaturationSnapshot;

  constructor(options: NodeSaturationMetricsOptions = {}) {
    this.sampleWindowMs = positiveFinite(options.sampleWindowMs, 1_000);
    const resolution = Math.max(1, Math.floor(positiveFinite(options.resolution, 20)));
    this.now = options.now ?? Date.now;
    this.readEventLoopUtilization = options.eventLoopUtilization ?? readEventLoopUtilization;
    this.histogram = options.createHistogram?.() ?? monitorEventLoopDelay({ resolution });
    this.setInterval = options.setInterval ?? ((callback, delay) => setInterval(callback, delay));
    this.clearInterval = options.clearInterval ?? ((timer) => clearInterval(timer));
    this.current = {
      eventLoopUtilization: 0,
      eventLoopDelayP50Ms: 0,
      eventLoopDelayP95Ms: 0,
      eventLoopDelayP99Ms: 0,
      sampleWindowMs: this.sampleWindowMs,
      sampledAt: null,
    };
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.previousUtilization = this.readEventLoopUtilization();
    this.histogram.enable();
    this.timer = this.setInterval(() => this.sample(), this.sampleWindowMs);
    (this.timer as unknown as { unref?: () => void }).unref?.();
  }

  close(): void {
    if (!this.started) return;
    this.started = false;
    if (this.timer !== undefined) {
      this.clearInterval(this.timer);
      this.timer = undefined;
    }
    this.histogram.disable();
    this.previousUtilization = undefined;
  }

  snapshot(): NodeSaturationSnapshot {
    return { ...this.current };
  }

  private sample(): void {
    if (!this.started) return;
    const previous = this.previousUtilization;
    const current = this.readEventLoopUtilization();
    this.previousUtilization = current;
    if (!previous) return;

    const active = Math.max(0, current.active - previous.active);
    const idle = Math.max(0, current.idle - previous.idle);
    const elapsed = active + idle;
    this.current = {
      eventLoopUtilization: clampRatio(elapsed > 0 ? active / elapsed : current.utilization),
      eventLoopDelayP50Ms: eventLoopDelayNanosecondsToMilliseconds(this.histogram.percentile(50)),
      eventLoopDelayP95Ms: eventLoopDelayNanosecondsToMilliseconds(this.histogram.percentile(95)),
      eventLoopDelayP99Ms: eventLoopDelayNanosecondsToMilliseconds(this.histogram.percentile(99)),
      sampleWindowMs: this.sampleWindowMs,
      sampledAt: new Date(this.now()).toISOString(),
    };
    this.histogram.reset?.();
  }
}

function readEventLoopUtilization(): EventLoopUtilizationReading {
  const { active, idle, utilization } = performance.eventLoopUtilization();
  return { active, idle, utilization };
}

function positiveFinite(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : fallback;
}

function clampRatio(value: number): number {
  return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
}
