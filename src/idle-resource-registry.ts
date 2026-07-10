export interface IdleResourceRegistryOptions {
  maxEntries: number;
  idleTtlMs: number;
  cleanupIntervalMs?: number;
  now?: () => number;
}

interface ResourceEntry<T> {
  value: T;
  lastUsedAtMs: number;
}

export class IdleResourceRegistry<T extends { close?: () => void | Promise<void> }> {
  private readonly entries = new Map<string, ResourceEntry<T>>();
  private readonly now: () => number;
  private readonly cleanupTimer: NodeJS.Timeout;

  constructor(private readonly options: IdleResourceRegistryOptions) {
    this.now = options.now ?? Date.now;
    const intervalMs = options.cleanupIntervalMs ?? Math.min(options.idleTtlMs, 60_000);
    this.cleanupTimer = setInterval(() => this.cleanup(), Math.max(1_000, intervalMs));
    this.cleanupTimer.unref();
  }

  set(key: string, value: T): void {
    this.cleanup();
    const existing = this.entries.get(key);
    if (existing && existing.value !== value) this.closeResource(existing.value);
    while (!this.entries.has(key) && this.entries.size >= this.options.maxEntries) {
      const oldest = this.oldestEntry();
      if (!oldest) break;
      this.remove(oldest[0], true);
    }
    this.entries.set(key, { value, lastUsedAtMs: this.now() });
  }

  get(key: string): T | undefined {
    this.cleanup();
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    entry.lastUsedAtMs = this.now();
    return entry.value;
  }

  delete(key: string): boolean {
    return this.remove(key, false);
  }

  cleanup(nowMs = this.now()): number {
    let removed = 0;
    for (const [key, entry] of this.entries) {
      if (nowMs - entry.lastUsedAtMs < this.options.idleTtlMs) continue;
      if (this.remove(key, true)) removed += 1;
    }
    return removed;
  }

  closeAll(): void {
    clearInterval(this.cleanupTimer);
    for (const key of Array.from(this.entries.keys())) this.remove(key, true);
  }

  get size(): number {
    return this.entries.size;
  }

  private oldestEntry(): [string, ResourceEntry<T>] | undefined {
    let oldest: [string, ResourceEntry<T>] | undefined;
    for (const entry of this.entries) {
      if (!oldest || entry[1].lastUsedAtMs < oldest[1].lastUsedAtMs) oldest = entry;
    }
    return oldest;
  }

  private remove(key: string, close: boolean): boolean {
    const entry = this.entries.get(key);
    if (!entry) return false;
    this.entries.delete(key);
    if (close) this.closeResource(entry.value);
    return true;
  }

  private closeResource(resource: T): void {
    try {
      void Promise.resolve(resource.close?.()).catch(() => undefined);
    } catch {
      // Resource cleanup is best effort; registry state is already removed.
    }
  }
}
