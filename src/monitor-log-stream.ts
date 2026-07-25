export type MonitorLogKind = "http" | "read" | "run" | "change" | "session" | "other";

export interface MonitorLogEntry {
  sequence: number;
  ts: string;
  level: "error" | "warn" | "info" | "debug";
  event: string;
  kind: MonitorLogKind;
  error: boolean;
  line: string;
  workspaceId?: string;
  tool?: string;
  details: Record<string, unknown>;
}

export interface MonitorLogPublishInput {
  ts: string;
  level: MonitorLogEntry["level"];
  event: string;
  kind: MonitorLogKind;
  error: boolean;
  line: string;
  workspaceId?: string;
  tool?: string;
  details: Record<string, unknown>;
}

export interface MonitorLogSnapshot {
  version: 1;
  generatedAt: number;
  latestSequence: number;
  logs: MonitorLogEntry[];
}

export type MonitorLogListener = (entry: MonitorLogEntry) => void;

export class MonitorLogStream {
  private readonly entries: MonitorLogEntry[] = [];
  private readonly listeners = new Set<MonitorLogListener>();
  private nextSequence = 1;

  constructor(private readonly capacity = 300) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new Error("Monitor log capacity must be a positive integer.");
    }
  }

  publish(input: MonitorLogPublishInput): MonitorLogEntry {
    const entry: MonitorLogEntry = {
      sequence: this.nextSequence++,
      ts: input.ts,
      level: input.level,
      event: input.event,
      kind: input.kind,
      error: input.error,
      line: input.line,
      workspaceId: input.workspaceId,
      tool: input.tool,
      details: { ...input.details },
    };
    this.entries.push(entry);
    if (this.entries.length > this.capacity) {
      this.entries.splice(0, this.entries.length - this.capacity);
    }
    for (const listener of this.listeners) {
      try {
        listener(entry);
      } catch {
        // Monitor consumers must never interfere with normal Workbridge logging.
      }
    }
    return entry;
  }

  snapshot(afterSequence = 0, limit = this.capacity): MonitorLogSnapshot {
    const normalizedAfter = Number.isSafeInteger(afterSequence) && afterSequence > 0
      ? afterSequence
      : 0;
    const normalizedLimit = Number.isSafeInteger(limit) && limit > 0
      ? Math.min(limit, this.capacity)
      : this.capacity;
    const logs = this.entries
      .filter((entry) => entry.sequence > normalizedAfter)
      .slice(-normalizedLimit)
      .map((entry) => ({ ...entry, details: { ...entry.details } }));
    return {
      version: 1,
      generatedAt: Date.now(),
      latestSequence: this.nextSequence - 1,
      logs,
    };
  }

  subscribe(listener: MonitorLogListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}

export const monitorLogStream = new MonitorLogStream();
