export interface ModernMcpRequestInput {
  requestId?: string;
  method: string;
  tool?: string;
  clientName?: string;
  clientVersion?: string;
  protocolVersion?: string;
}

export interface ModernMcpPhaseTimings {
  authMs?: number;
  classifyMs?: number;
  registrationMs?: number;
  handlerMs?: number;
  totalMs?: number;
}

export interface ModernMcpPhaseTimingSummary {
  count: number;
  p50?: number;
  p95?: number;
  p99?: number;
  mean?: number;
}

type ModernMcpPhaseName = keyof ModernMcpPhaseTimings;

export interface ModernMcpRequestSnapshot {
  stats: {
    requests: number;
    requestsTotal: number;
    active: number;
    activeRequests: number;
    peakActiveRequests: number;
    activeRegistrations: number;
    peakActiveRegistrations: number;
    activeHandlers: number;
    peakActiveHandlers: number;
    requestsCompleted: number;
    toolsList: number;
    toolsCall: number;
    success: number;
    error: number;
  };
  phaseTimings: Record<ModernMcpPhaseName, ModernMcpPhaseTimingSummary>;
  recent: Array<ModernMcpRequestInput & {
    timings?: ModernMcpPhaseTimings;
    status: "running" | "success" | "error";
    startedAt: string;
    durationMs: number;
    concurrencyAtStart: number;
    peakConcurrencyDuringRequest: number;
    overlapped: boolean;
  }>;
}

interface ModernMcpRequestRecord extends ModernMcpRequestInput {
  timings?: ModernMcpPhaseTimings;
  startedAtMs: number;
  status: "running" | "success" | "error";
  durationMs: number;
  concurrencyAtStart: number;
  peakConcurrencyDuringRequest: number;
  overlapped: boolean;
}

const RECENT_REQUEST_LIMIT = 32;
const TIMING_SAMPLE_LIMIT = 2_048;
const PHASE_NAMES: ModernMcpPhaseName[] = [
  "authMs",
  "classifyMs",
  "registrationMs",
  "handlerMs",
  "totalMs",
];

export class ModernMcpRequestMetrics {
  private readonly active = new Map<symbol, ModernMcpRequestRecord>();
  private readonly activeRegistrations = new Set<symbol>();
  private readonly activeHandlers = new Set<symbol>();
  private readonly recent: ModernMcpRequestRecord[] = [];
  private readonly timingSamples = new Map<ModernMcpPhaseName, number[]>(
    PHASE_NAMES.map((name) => [name, []]),
  );
  private requests = 0;
  private peakActiveRequests = 0;
  private peakActiveRegistrations = 0;
  private peakActiveHandlers = 0;
  private toolsList = 0;
  private toolsCall = 0;
  private success = 0;
  private error = 0;

  constructor(private readonly now: () => number = Date.now) {}

  begin(input: ModernMcpRequestInput): symbol {
    const id = Symbol("modern-mcp-request");
    this.requests += 1;
    if (input.method === "tools/list") this.toolsList += 1;
    if (input.method === "tools/call") this.toolsCall += 1;
    const concurrencyAtStart = this.active.size + 1;
    for (const request of this.active.values()) {
      request.peakConcurrencyDuringRequest = Math.max(
        request.peakConcurrencyDuringRequest,
        concurrencyAtStart,
      );
      request.overlapped = request.peakConcurrencyDuringRequest > 1;
    }
    this.active.set(id, {
      ...input,
      startedAtMs: this.now(),
      status: "running",
      durationMs: 0,
      concurrencyAtStart,
      peakConcurrencyDuringRequest: concurrencyAtStart,
      overlapped: concurrencyAtStart > 1,
    });
    this.peakActiveRequests = Math.max(this.peakActiveRequests, concurrencyAtStart);
    return id;
  }

  beginRegistration(reference: symbol): void {
    if (!this.active.has(reference)) return;
    this.activeRegistrations.add(reference);
    this.peakActiveRegistrations = Math.max(
      this.peakActiveRegistrations,
      this.activeRegistrations.size,
    );
  }

  endRegistration(reference: symbol): void {
    this.activeRegistrations.delete(reference);
  }

  beginHandler(reference: symbol): void {
    if (!this.active.has(reference)) return;
    this.activeHandlers.add(reference);
    this.peakActiveHandlers = Math.max(this.peakActiveHandlers, this.activeHandlers.size);
  }

  endHandler(reference: symbol): void {
    this.activeHandlers.delete(reference);
  }

  recordTimings(reference: symbol, timings: ModernMcpPhaseTimings): void {
    const request = this.active.get(reference);
    if (!request) return;
    const normalized = Object.fromEntries(
      Object.entries(timings)
        .filter(([, value]) => typeof value === "number" && Number.isFinite(value) && value >= 0),
    ) as ModernMcpPhaseTimings;
    request.timings = { ...request.timings, ...normalized };
  }

  finish(reference: symbol, succeeded: boolean): void {
    const request = this.active.get(reference);
    if (!request) return;
    this.active.delete(reference);
    request.status = succeeded ? "success" : "error";
    request.durationMs = Math.max(0, this.now() - request.startedAtMs);
    if (succeeded) this.success += 1;
    else this.error += 1;
    this.recent.unshift(request);
    this.recent.length = Math.min(this.recent.length, RECENT_REQUEST_LIMIT);
    for (const phase of PHASE_NAMES) {
      const value = request.timings?.[phase];
      if (typeof value !== "number" || !Number.isFinite(value) || value < 0) continue;
      const samples = this.timingSamples.get(phase)!;
      samples.push(value);
      if (samples.length > TIMING_SAMPLE_LIMIT) samples.shift();
    }
  }

  snapshot(limit = 8): ModernMcpRequestSnapshot {
    const now = this.now();
    const recent = [...this.active.values(), ...this.recent]
      .sort((left, right) => right.startedAtMs - left.startedAtMs)
      .slice(0, Math.max(0, limit))
      .map(({ startedAtMs, ...request }) => ({
        ...request,
        startedAt: new Date(startedAtMs).toISOString(),
        durationMs: request.status === "running"
          ? Math.max(0, now - startedAtMs)
          : request.durationMs,
      }));
    return {
      stats: {
        requests: this.requests,
        requestsTotal: this.requests,
        active: this.active.size,
        activeRequests: this.active.size,
        peakActiveRequests: this.peakActiveRequests,
        activeRegistrations: this.activeRegistrations.size,
        peakActiveRegistrations: this.peakActiveRegistrations,
        activeHandlers: this.activeHandlers.size,
        peakActiveHandlers: this.peakActiveHandlers,
        requestsCompleted: this.success + this.error,
        toolsList: this.toolsList,
        toolsCall: this.toolsCall,
        success: this.success,
        error: this.error,
      },
      phaseTimings: Object.fromEntries(
        PHASE_NAMES.map((phase) => [phase, summarizeSamples(this.timingSamples.get(phase)!)]),
      ) as Record<ModernMcpPhaseName, ModernMcpPhaseTimingSummary>,
      recent,
    };
  }
}

function summarizeSamples(values: readonly number[]): ModernMcpPhaseTimingSummary {
  if (values.length === 0) return { count: 0 };
  const sorted = [...values].sort((left, right) => left - right);
  return {
    count: sorted.length,
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    p99: percentile(sorted, 0.99),
    mean: sorted.reduce((sum, value) => sum + value, 0) / sorted.length,
  };
}

function percentile(sorted: readonly number[], fraction: number): number {
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)]!;
}
