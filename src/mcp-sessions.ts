import { sessionIdPrefix } from "./logger.js";

export interface ClosableMcpTransport {
  close(): Promise<void>;
}

export interface McpSessionCloseResult {
  sessionId: string;
  error?: unknown;
}

export interface McpSessionMetadata {
  clientName?: string;
  clientVersion?: string;
  protocolVersion?: string;
  userAgent?: string;
}

export interface McpSessionStats {
  active: number;
  activeRequests: number;
  initializedOnly: number;
  handshakeOnly: number;
  discoveryOnly: number;
  operational: number;
  toolCallSessions: number;
  oneShotCleanupCandidates: number;
  reusedToolCallSessions: number;
  maxToolCallsPerSession: number;
  totalCreated: number;
  totalClosed: number;
  totalSubsequentRequests: number;
  oldestAgeMs: number;
  longestIdleMs: number;
  requestMethods: Record<string, number>;
  clientNames: Record<string, number>;
  protocolVersions: Record<string, number>;
}

export interface McpSessionSummary {
  sessionIdPrefix: string;
  clientName: string;
  state: "active" | "operational" | "discovery" | "handshake" | "initialized";
  ageMs: number;
  idleMs: number;
  activeRequests: number;
  toolCalls: number;
  subsequentRequests: number;
}

export interface McpSessionSnapshot {
  stats: McpSessionStats;
  recent: McpSessionSummary[];
}

interface McpSessionEntry<TTransport> {
  transport: TTransport;
  metadata: McpSessionMetadata;
  createdAt: number;
  lastActivityAt: number;
  activeRequestCount: number;
  oneShotCleanupEligible: boolean;
  subsequentRequestCount: number;
  handshakeRequestCount: number;
  discoveryRequestCount: number;
  operationalRequestCount: number;
  toolCallCount: number;
}

export interface McpSessionRegistryOptions {
  now?: () => number;
}

export interface McpSessionRegistrationOptions {
  requestActive?: boolean;
  oneShotCleanupEligible?: boolean;
}

export class McpSessionRegistry<TTransport extends ClosableMcpTransport> {
  private readonly sessions = new Map<string, McpSessionEntry<TTransport>>();
  private readonly now: () => number;
  private readonly requestMethods = new Map<string, number>();
  private readonly clientNames = new Map<string, number>();
  private readonly protocolVersions = new Map<string, number>();
  private totalCreated = 0;
  private totalClosed = 0;
  private totalSubsequentRequests = 0;

  constructor(options: McpSessionRegistryOptions = {}) {
    this.now = options.now ?? Date.now;
  }

  get size(): number {
    return this.sessions.size;
  }

  register(
    sessionId: string,
    transport: TTransport,
    metadata: McpSessionMetadata = {},
    options: McpSessionRegistrationOptions = {},
  ): void {
    const timestamp = this.now();
    this.sessions.set(sessionId, {
      transport,
      metadata: { ...metadata },
      createdAt: timestamp,
      lastActivityAt: timestamp,
      activeRequestCount: options.requestActive ? 1 : 0,
      oneShotCleanupEligible: options.oneShotCleanupEligible ?? false,
      subsequentRequestCount: 0,
      handshakeRequestCount: 0,
      discoveryRequestCount: 0,
      operationalRequestCount: 0,
      toolCallCount: 0,
    });
    this.totalCreated += 1;
    incrementCounter(this.clientNames, metadata.clientName ?? "unknown", 32);
    incrementCounter(this.protocolVersions, metadata.protocolVersion ?? "unknown", 16);
  }

  beginRequest(sessionId: string, methods: readonly string[] = []): TTransport | undefined {
    const entry = this.sessions.get(sessionId);
    if (!entry) return undefined;

    entry.lastActivityAt = this.now();
    entry.activeRequestCount += 1;
    entry.subsequentRequestCount += 1;
    this.totalSubsequentRequests += 1;

    const classifiedMethods = methods.length > 0 ? methods : ["unknown"];
    for (const method of classifiedMethods) {
      incrementCounter(this.requestMethods, method, 64);
      const classification = classifyRequestMethod(method);
      if (classification === "handshake") entry.handshakeRequestCount += 1;
      else if (classification === "discovery") entry.discoveryRequestCount += 1;
      else entry.operationalRequestCount += 1;
      if (method === "tools/call") entry.toolCallCount += 1;
    }
    return entry.transport;
  }

  endRequest(sessionId: string): boolean {
    const entry = this.sessions.get(sessionId);
    if (!entry || entry.activeRequestCount === 0) return false;
    entry.activeRequestCount -= 1;
    entry.lastActivityAt = this.now();
    return true;
  }

  remove(sessionId: string): boolean {
    const removed = this.sessions.delete(sessionId);
    if (removed) this.totalClosed += 1;
    return removed;
  }

  stats(): McpSessionStats {
    const now = this.now();
    let activeRequests = 0;
    let initializedOnly = 0;
    let handshakeOnly = 0;
    let discoveryOnly = 0;
    let operational = 0;
    let toolCallSessions = 0;
    let oneShotCleanupCandidates = 0;
    let reusedToolCallSessions = 0;
    let maxToolCallsPerSession = 0;
    let oldestAgeMs = 0;
    let longestIdleMs = 0;

    for (const entry of this.sessions.values()) {
      activeRequests += entry.activeRequestCount;
      oldestAgeMs = Math.max(oldestAgeMs, now - entry.createdAt);
      longestIdleMs = Math.max(longestIdleMs, now - entry.lastActivityAt);
      if (entry.subsequentRequestCount === 0) initializedOnly += 1;
      else if (entry.operationalRequestCount > 0) operational += 1;
      else if (entry.discoveryRequestCount > 0) discoveryOnly += 1;
      else handshakeOnly += 1;
      if (entry.toolCallCount > 0) toolCallSessions += 1;
      if (entry.oneShotCleanupEligible && entry.toolCallCount === 1) oneShotCleanupCandidates += 1;
      if (entry.toolCallCount > 1) reusedToolCallSessions += 1;
      maxToolCallsPerSession = Math.max(maxToolCallsPerSession, entry.toolCallCount);
    }

    return {
      active: this.sessions.size,
      activeRequests,
      initializedOnly,
      handshakeOnly,
      discoveryOnly,
      operational,
      toolCallSessions,
      oneShotCleanupCandidates,
      reusedToolCallSessions,
      maxToolCallsPerSession,
      totalCreated: this.totalCreated,
      totalClosed: this.totalClosed,
      totalSubsequentRequests: this.totalSubsequentRequests,
      oldestAgeMs,
      longestIdleMs,
      requestMethods: sortedCounter(this.requestMethods),
      clientNames: sortedCounter(this.clientNames),
      protocolVersions: sortedCounter(this.protocolVersions),
    };
  }

  snapshot(limit = 8): McpSessionSnapshot {
    const now = this.now();
    const recent = Array.from(this.sessions, ([sessionId, entry]) => ({
      sessionIdPrefix: sessionIdPrefix(sessionId) ?? sessionId.slice(0, 10),
      clientName: entry.metadata.clientName ?? "unknown",
      state: sessionState(entry),
      ageMs: Math.max(0, now - entry.createdAt),
      idleMs: Math.max(0, now - entry.lastActivityAt),
      activeRequests: entry.activeRequestCount,
      toolCalls: entry.toolCallCount,
      subsequentRequests: entry.subsequentRequestCount,
      lastActivityAt: entry.lastActivityAt,
    }))
      .sort((left, right) => right.lastActivityAt - left.lastActivityAt)
      .slice(0, Math.max(0, Math.min(50, Math.trunc(limit))))
      .map(({ lastActivityAt: _lastActivityAt, ...summary }) => summary);

    return { stats: this.stats(), recent };
  }

  async closePreUse(idleTimeoutMs: number): Promise<McpSessionCloseResult[]> {
    const cutoff = this.now() - idleTimeoutMs;
    const unusedSessions: Array<{ sessionId: string; transport: TTransport }> = [];

    for (const [sessionId, entry] of this.sessions) {
      if (
        entry.activeRequestCount > 0
        || entry.operationalRequestCount > 0
        || (entry.discoveryRequestCount > 0 && !entry.oneShotCleanupEligible)
        || entry.lastActivityAt > cutoff
      ) {
        continue;
      }

      this.sessions.delete(sessionId);
      unusedSessions.push({ sessionId, transport: entry.transport });
    }

    this.totalClosed += unusedSessions.length;
    return closeSessions(unusedSessions);
  }

  async closeOneShot(idleTimeoutMs: number): Promise<McpSessionCloseResult[]> {
    const cutoff = this.now() - idleTimeoutMs;
    const oneShotSessions: Array<{ sessionId: string; transport: TTransport }> = [];

    for (const [sessionId, entry] of this.sessions) {
      if (
        entry.activeRequestCount > 0
        || !entry.oneShotCleanupEligible
        || entry.toolCallCount !== 1
        || entry.lastActivityAt > cutoff
      ) {
        continue;
      }

      this.sessions.delete(sessionId);
      oneShotSessions.push({ sessionId, transport: entry.transport });
    }

    this.totalClosed += oneShotSessions.length;
    return closeSessions(oneShotSessions);
  }

  async closeIdle(idleTimeoutMs: number): Promise<McpSessionCloseResult[]> {
    const cutoff = this.now() - idleTimeoutMs;
    const idleSessions: Array<{ sessionId: string; transport: TTransport }> = [];

    for (const [sessionId, entry] of this.sessions) {
      if (entry.activeRequestCount > 0 || entry.lastActivityAt > cutoff) continue;

      this.sessions.delete(sessionId);
      idleSessions.push({ sessionId, transport: entry.transport });
    }

    this.totalClosed += idleSessions.length;
    return closeSessions(idleSessions);
  }

  async closeAll(): Promise<McpSessionCloseResult[]> {
    const sessions = Array.from(this.sessions, ([sessionId, entry]) => ({
      sessionId,
      transport: entry.transport,
    }));
    this.sessions.clear();
    this.totalClosed += sessions.length;
    return closeSessions(sessions);
  }
}

function sessionState<TTransport>(
  entry: McpSessionEntry<TTransport>,
): McpSessionSummary["state"] {
  if (entry.activeRequestCount > 0) return "active";
  if (entry.operationalRequestCount > 0) return "operational";
  if (entry.discoveryRequestCount > 0) return "discovery";
  if (entry.handshakeRequestCount > 0) return "handshake";
  return "initialized";
}

function classifyRequestMethod(method: string): "handshake" | "discovery" | "operational" {
  if (
    method === "notifications/initialized"
    || method === "ping"
    || method === "http/get"
    || method === "http/head"
    || method === "http/options"
  ) {
    return "handshake";
  }
  if (
    method === "tools/list"
    || method === "resources/list"
    || method === "resources/templates/list"
    || method === "prompts/list"
  ) {
    return "discovery";
  }
  return "operational";
}

function incrementCounter(counter: Map<string, number>, rawKey: string, maxKeys: number): void {
  const normalized = rawKey.trim().slice(0, 160) || "unknown";
  const key = counter.has(normalized) || counter.size < maxKeys ? normalized : "other";
  counter.set(key, (counter.get(key) ?? 0) + 1);
}

function sortedCounter(counter: ReadonlyMap<string, number>): Record<string, number> {
  return Object.fromEntries(
    Array.from(counter.entries()).sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0])),
  );
}

async function closeSessions<TTransport extends ClosableMcpTransport>(
  sessions: Array<{ sessionId: string; transport: TTransport }>,
): Promise<McpSessionCloseResult[]> {
  return Promise.all(
    sessions.map(async ({ sessionId, transport }) => {
      try {
        await transport.close();
        return { sessionId };
      } catch (error) {
        return { sessionId, error };
      }
    }),
  );
}
