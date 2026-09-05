import { sessionIdPrefix } from "./logger.js";
import {
  McpSessionRegistry,
  type ClosableMcpTransport,
  type McpSessionCloseResult,
  type McpSessionMetadata,
  type McpSessionRegistrationOptions,
  type McpSessionSnapshot,
  type McpSessionStats,
} from "./mcp-sessions.js";

export const MCP_SESSION_IDLE_TIMEOUT_MS = 24 * 60 * 60 * 1_000;
export const MCP_PRE_USE_IDLE_TIMEOUT_MS = 15 * 60 * 1_000;
export const MCP_ONE_SHOT_GRACE_MS = 60 * 1_000;
export const MCP_SESSION_CLEANUP_INTERVAL_MS = 60 * 1_000;
export const MCP_SESSION_WARNING_THRESHOLDS = [128, 512] as const;

export type McpSessionCloseReason =
  | "pre_use_timeout"
  | "one_shot_timeout"
  | "idle_timeout"
  | "transport_close"
  | "server_shutdown";

export type McpSessionLifecycleLogLevel = "info" | "warn";

export type McpSessionLifecycleLogger = (
  level: McpSessionLifecycleLogLevel,
  event: string,
  fields: Record<string, unknown>,
) => void;

export interface McpResponseLifecycle {
  readonly writableEnded: boolean;
  readonly destroyed: boolean;
  once(event: "finish" | "close", listener: () => void): unknown;
}

type IntervalHandle = ReturnType<typeof setInterval>;

export interface McpSessionLifecycleOptions<TTransport extends ClosableMcpTransport> {
  registry?: McpSessionRegistry<TTransport>;
  log?: McpSessionLifecycleLogger;
  memoryUsage?: () => NodeJS.MemoryUsage;
  uptime?: () => number;
  preUseIdleTimeoutMs?: number;
  oneShotGraceMs?: number;
  idleTimeoutMs?: number;
  cleanupIntervalMs?: number;
  warningThresholds?: readonly number[];
  scheduleInterval?: (callback: () => void, intervalMs: number) => IntervalHandle;
  cancelInterval?: (handle: IntervalHandle) => void;
}

export class McpSessionLifecycle<TTransport extends ClosableMcpTransport> {
  private readonly registry: McpSessionRegistry<TTransport>;
  private readonly log: McpSessionLifecycleLogger;
  private readonly memoryUsage: () => NodeJS.MemoryUsage;
  private readonly uptime: () => number;
  private readonly preUseIdleTimeoutMs: number;
  private readonly oneShotGraceMs: number;
  private readonly idleTimeoutMs: number;
  private readonly cleanupIntervalMs: number;
  private readonly warningThresholds: readonly number[];
  private readonly scheduleInterval: (callback: () => void, intervalMs: number) => IntervalHandle;
  private readonly cancelInterval: (handle: IntervalHandle) => void;
  private readonly warnedSessionThresholds = new Set<number>();
  private cleanupTimer: IntervalHandle | undefined;
  private cleanupPromise: Promise<void> | undefined;
  private closePromise: Promise<void> | undefined;
  private closed = false;

  constructor(options: McpSessionLifecycleOptions<TTransport> = {}) {
    this.registry = options.registry ?? new McpSessionRegistry<TTransport>();
    this.log = options.log ?? (() => undefined);
    this.memoryUsage = options.memoryUsage ?? process.memoryUsage;
    this.uptime = options.uptime ?? process.uptime;
    this.preUseIdleTimeoutMs = options.preUseIdleTimeoutMs ?? MCP_PRE_USE_IDLE_TIMEOUT_MS;
    this.oneShotGraceMs = options.oneShotGraceMs ?? MCP_ONE_SHOT_GRACE_MS;
    this.idleTimeoutMs = options.idleTimeoutMs ?? MCP_SESSION_IDLE_TIMEOUT_MS;
    this.cleanupIntervalMs = options.cleanupIntervalMs ?? MCP_SESSION_CLEANUP_INTERVAL_MS;
    this.warningThresholds = options.warningThresholds ?? MCP_SESSION_WARNING_THRESHOLDS;
    this.scheduleInterval = options.scheduleInterval ?? setInterval;
    this.cancelInterval = options.cancelInterval ?? clearInterval;
  }

  get size(): number {
    return this.registry.size;
  }

  stats(): McpSessionStats {
    return this.registry.stats();
  }

  snapshot(limit = 8): McpSessionSnapshot {
    return this.registry.snapshot(limit);
  }

  start(): void {
    if (this.closed) throw new Error("MCP session lifecycle is already closed.");
    if (this.cleanupTimer) return;

    this.cleanupTimer = this.scheduleInterval(() => {
      void this.cleanupNow();
    }, this.cleanupIntervalMs);
    (this.cleanupTimer as { unref?: () => void }).unref?.();
    this.logMetrics("mcp_session_metrics_startup");
  }

  register(
    sessionId: string,
    transport: TTransport,
    metadata: McpSessionMetadata = {},
    options: McpSessionRegistrationOptions = {},
  ): void {
    this.registry.register(sessionId, transport, metadata, options);
    this.warnSessionPressureIfNeeded();
  }

  beginRequest(sessionId: string, methods: readonly string[] = []): TTransport | undefined {
    return this.registry.beginRequest(sessionId, methods);
  }

  endRequest(sessionId: string): boolean {
    return this.registry.endRequest(sessionId);
  }

  trackRequestUntilResponseEnd(sessionId: string, response: McpResponseLifecycle): () => void {
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      this.registry.endRequest(sessionId);
    };

    response.once("finish", release);
    response.once("close", release);
    if (response.writableEnded || response.destroyed) release();
    return release;
  }

  remove(sessionId: string, reason: McpSessionCloseReason): boolean {
    if (!this.registry.remove(sessionId)) return false;
    this.log("info", "mcp_session_closed", {
      reason,
      sessionIdPrefix: sessionIdPrefix(sessionId),
      activeSessionCount: this.registry.size,
    });
    return true;
  }

  cleanupNow(): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (this.cleanupPromise) return this.cleanupPromise;

    const cleanup = this.performCleanup()
      .catch((error) => {
        this.log("warn", "mcp_session_cleanup_failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => {
        if (this.cleanupPromise === cleanup) this.cleanupPromise = undefined;
      });
    this.cleanupPromise = cleanup;
    return cleanup;
  }

  close(): Promise<void> {
    this.closePromise ??= (async () => {
      this.closed = true;
      if (this.cleanupTimer) {
        this.cancelInterval(this.cleanupTimer);
        this.cleanupTimer = undefined;
      }
      await this.cleanupPromise;
      const results = await this.registry.closeAll();
      this.logCloseResults("server_shutdown", results);
    })();
    return this.closePromise;
  }

  private async performCleanup(): Promise<void> {
    const preUseResults = await this.registry.closePreUse(this.preUseIdleTimeoutMs);
    this.logCloseResults("pre_use_timeout", preUseResults);
    const oneShotResults = await this.registry.closeOneShot(this.oneShotGraceMs);
    this.logCloseResults("one_shot_timeout", oneShotResults);
    const idleResults = await this.registry.closeIdle(this.idleTimeoutMs);
    this.logCloseResults("idle_timeout", idleResults);
    this.logMetrics();
  }

  private logMetrics(event = "mcp_session_metrics"): void {
    const stats = this.registry.stats();
    const memory = this.memoryUsage();
    this.log("info", event, {
      ...stats,
      rssBytes: memory.rss,
      heapUsedBytes: memory.heapUsed,
      heapTotalBytes: memory.heapTotal,
      externalBytes: memory.external,
      arrayBuffersBytes: memory.arrayBuffers,
      uptimeSeconds: Math.round(this.uptime()),
    });
    this.warnSessionPressureIfNeeded(stats, memory);
  }

  private warnSessionPressureIfNeeded(
    stats = this.registry.stats(),
    memory = this.memoryUsage(),
  ): void {
    for (const threshold of this.warningThresholds) {
      if (stats.active < threshold) {
        this.warnedSessionThresholds.delete(threshold);
        continue;
      }
      if (this.warnedSessionThresholds.has(threshold)) continue;
      this.warnedSessionThresholds.add(threshold);
      this.log("warn", "mcp_session_pressure", {
        threshold,
        ...stats,
        rssBytes: memory.rss,
        heapUsedBytes: memory.heapUsed,
      });
    }
  }

  private logCloseResults(reason: McpSessionCloseReason, results: McpSessionCloseResult[]): void {
    for (const result of results) {
      if (result.error) {
        this.log("warn", "mcp_session_close_failed", {
          reason,
          sessionIdPrefix: sessionIdPrefix(result.sessionId),
          error: result.error instanceof Error ? result.error.message : String(result.error),
        });
        continue;
      }

      this.log("info", "mcp_session_closed", {
        reason,
        sessionIdPrefix: sessionIdPrefix(result.sessionId),
        activeSessionCount: this.registry.size,
      });
    }
  }
}

export function isOpenAiMcpClient(metadata: McpSessionMetadata): boolean {
  return metadata.clientName?.trim().toLowerCase() === "openai-mcp"
    || metadata.userAgent?.trim().toLowerCase().startsWith("openai-mcp/") === true;
}
