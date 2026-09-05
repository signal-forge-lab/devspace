export interface AuthorizationRateLimitConfig {
  maxFailures: number;
  failureWindowMs: number;
  blockDurationMs: number;
  failureDelayMs: number;
}

interface AttemptState {
  failures: number[];
  blockedUntilMs?: number;
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

export function isAllowedOAuthRedirectUri(redirectUri: string, allowedHosts: readonly string[]): boolean {
  let parsed: URL;
  try {
    parsed = new URL(redirectUri);
  } catch {
    return false;
  }

  if (parsed.username || parsed.password || parsed.hash) return false;
  const hostname = parsed.hostname.toLowerCase();
  const protocol = parsed.protocol.toLowerCase();
  if (LOOPBACK_HOSTS.has(hostname)) return protocol === "http:" || protocol === "https:";
  return protocol === "https:" && allowedHosts.some((host) => host.toLowerCase() === hostname);
}

export class AuthorizationAttemptLimiter {
  private readonly attempts = new Map<string, AttemptState>();

  constructor(private readonly config: AuthorizationRateLimitConfig) {}

  retryAfterMs(key: string, nowMs = Date.now()): number {
    const state = this.attempts.get(key);
    if (!state?.blockedUntilMs) return 0;
    if (state.blockedUntilMs <= nowMs) {
      this.attempts.delete(key);
      return 0;
    }
    return state.blockedUntilMs - nowMs;
  }

  recordFailure(key: string, nowMs = Date.now()): number {
    const cutoff = nowMs - this.config.failureWindowMs;
    const state = this.attempts.get(key) ?? { failures: [] };
    state.failures = state.failures.filter((timestamp) => timestamp >= cutoff);
    state.failures.push(nowMs);
    if (state.failures.length >= this.config.maxFailures) {
      state.blockedUntilMs = nowMs + this.config.blockDurationMs;
    }
    this.attempts.set(key, state);
    return this.retryAfterMs(key, nowMs);
  }

  recordSuccess(key: string): void {
    this.attempts.delete(key);
  }

  prune(nowMs = Date.now()): void {
    const cutoff = nowMs - this.config.failureWindowMs;
    for (const [key, state] of this.attempts) {
      const failures = state.failures.filter((timestamp) => timestamp >= cutoff);
      const blocked = state.blockedUntilMs !== undefined && state.blockedUntilMs > nowMs;
      if (!blocked && failures.length === 0) this.attempts.delete(key);
      else this.attempts.set(key, { failures, blockedUntilMs: blocked ? state.blockedUntilMs : undefined });
    }
  }
}

export function requestAddress(request: {
  ip?: string;
  socket?: { remoteAddress?: string | null };
}): string {
  return request.ip?.trim() || request.socket?.remoteAddress?.trim() || "unknown";
}

export function delay(milliseconds: number): Promise<void> {
  if (milliseconds <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
