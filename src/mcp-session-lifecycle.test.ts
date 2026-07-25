import assert from "node:assert/strict";
import { createServer as createHttpServer, get as httpGet, type Server } from "node:http";
import { McpSessionLifecycle, isOpenAiMcpClient } from "./mcp-session-lifecycle.js";
import { McpSessionRegistry } from "./mcp-sessions.js";

interface LoggedEvent {
  level: "info" | "warn";
  event: string;
  fields: Record<string, unknown>;
}

class FakeTransport {
  closeCalls = 0;

  constructor(private readonly closeGate?: Promise<void>) {}

  async close(): Promise<void> {
    this.closeCalls += 1;
    await this.closeGate;
  }
}

await testHttpFinishReleasesActiveRequest();
await testHttpCloseReleasesActiveRequest();
testAlreadyEndedResponseReleasesImmediately();
await testStartAndShutdownOwnCleanupTimer();
await testCleanupRunsOnlyOnceAtATime();
await testShutdownWaitsForInFlightCleanup();
await testCloseFailureIsLogged();
await testPressureWarningCanReset();
testOpenAiClientDetection();

console.log("mcp session lifecycle tests passed");

async function testHttpFinishReleasesActiveRequest(): Promise<void> {
  const lifecycle = new McpSessionLifecycle<FakeTransport>();
  lifecycle.register("finish-session", new FakeTransport(), {}, { requestActive: true });

  const server = createHttpServer((_request, response) => {
    lifecycle.trackRequestUntilResponseEnd("finish-session", response);
    response.end("ok");
  });
  const url = await listen(server);
  await getAndDrain(url);

  assert.equal(lifecycle.stats().activeRequests, 0);
  await closeHttpServer(server);
  await lifecycle.close();
}

async function testHttpCloseReleasesActiveRequest(): Promise<void> {
  const lifecycle = new McpSessionLifecycle<FakeTransport>();
  lifecycle.register("close-session", new FakeTransport(), {}, { requestActive: true });

  const responseClosed = deferred<void>();
  const server = createHttpServer((_request, response) => {
    lifecycle.trackRequestUntilResponseEnd("close-session", response);
    response.once("close", () => responseClosed.resolve());
    response.writeHead(200, { "content-type": "text/plain" });
    response.flushHeaders();
  });
  const url = await listen(server);

  await withTimeout(new Promise<void>((resolve, reject) => {
    const request = httpGet(url, (response) => {
      response.once("error", () => undefined);
      response.destroy();
      request.destroy();
      resolve();
    });
    request.once("error", (error) => {
      if ((error as NodeJS.ErrnoException).code === "ECONNRESET") resolve();
      else reject(error);
    });
  }));
  await withTimeout(responseClosed.promise);

  assert.equal(lifecycle.stats().activeRequests, 0);
  await closeHttpServer(server);
  await lifecycle.close();
}

function testAlreadyEndedResponseReleasesImmediately(): void {
  const lifecycle = new McpSessionLifecycle<FakeTransport>();
  lifecycle.register("ended-session", new FakeTransport(), {}, { requestActive: true });
  lifecycle.trackRequestUntilResponseEnd("ended-session", {
    writableEnded: true,
    destroyed: false,
    once: () => undefined,
  });
  assert.equal(lifecycle.stats().activeRequests, 0);
}

async function testStartAndShutdownOwnCleanupTimer(): Promise<void> {
  let scheduled = 0;
  let cancelled = 0;
  let unrefCalls = 0;
  let scheduledIntervalMs: number | undefined;
  const events: LoggedEvent[] = [];
  const intervalHandle = {
    unref: () => {
      unrefCalls += 1;
    },
  } as unknown as ReturnType<typeof setInterval>;
  const lifecycle = new McpSessionLifecycle<FakeTransport>({
    log: (level, event, fields) => events.push({ level, event, fields }),
    memoryUsage: () => ({
      rss: 1,
      heapTotal: 2,
      heapUsed: 3,
      external: 4,
      arrayBuffers: 5,
    }),
    uptime: () => 12.4,
    scheduleInterval: (_callback, intervalMs) => {
      scheduled += 1;
      scheduledIntervalMs = intervalMs;
      return intervalHandle;
    },
    cancelInterval: (handle) => {
      assert.equal(handle, intervalHandle);
      cancelled += 1;
    },
  });

  lifecycle.start();
  lifecycle.start();
  assert.equal(scheduled, 1);
  assert.equal(scheduledIntervalMs, 60_000);
  assert.equal(unrefCalls, 1);
  assert.equal(events.filter((entry) => entry.event === "mcp_session_metrics_startup").length, 1);
  await lifecycle.close();
  await lifecycle.close();
  assert.equal(cancelled, 1);
}

async function testCleanupRunsOnlyOnceAtATime(): Promise<void> {
  let now = 0;
  const closeGate = deferred<void>();
  const transport = new FakeTransport(closeGate.promise);
  const events: LoggedEvent[] = [];
  const registry = new McpSessionRegistry<FakeTransport>({ now: () => now });
  registry.register("stale", transport);
  now = 20 * 60 * 1_000;

  const lifecycle = new McpSessionLifecycle({
    registry,
    preUseIdleTimeoutMs: 10 * 60 * 1_000,
    log: (level, event, fields) => events.push({ level, event, fields }),
  });
  const first = lifecycle.cleanupNow();
  const second = lifecycle.cleanupNow();
  assert.equal(first, second);
  await Promise.resolve();
  assert.equal(transport.closeCalls, 1);

  closeGate.resolve();
  await first;
  assert.equal(lifecycle.size, 0);
  assert.equal(
    events.some((entry) => entry.event === "mcp_session_closed" && entry.fields.reason === "pre_use_timeout"),
    true,
  );
  await lifecycle.close();
}

async function testShutdownWaitsForInFlightCleanup(): Promise<void> {
  let now = 0;
  const closeGate = deferred<void>();
  const staleTransport = new FakeTransport(closeGate.promise);
  const activeTransport = new FakeTransport();
  const registry = new McpSessionRegistry<FakeTransport>({ now: () => now });
  registry.register("stale", staleTransport);
  registry.register("active", activeTransport, {}, { requestActive: true });
  now = 20 * 60 * 1_000;

  const lifecycle = new McpSessionLifecycle({
    registry,
    preUseIdleTimeoutMs: 10 * 60 * 1_000,
  });
  const cleanup = lifecycle.cleanupNow();
  const shutdown = lifecycle.close();
  await Promise.resolve();

  assert.equal(staleTransport.closeCalls, 1);
  assert.equal(activeTransport.closeCalls, 0);
  closeGate.resolve();
  await Promise.all([cleanup, shutdown]);
  assert.equal(activeTransport.closeCalls, 1);
  assert.equal(lifecycle.size, 0);
}

async function testCloseFailureIsLogged(): Promise<void> {
  let now = 0;
  const transport = {
    closeCalls: 0,
    async close(): Promise<void> {
      this.closeCalls += 1;
      throw new Error("synthetic close failure");
    },
  };
  const events: LoggedEvent[] = [];
  const registry = new McpSessionRegistry<typeof transport>({ now: () => now });
  registry.register("failing-session", transport);
  now = 20 * 60 * 1_000;

  const lifecycle = new McpSessionLifecycle({
    registry,
    preUseIdleTimeoutMs: 10 * 60 * 1_000,
    log: (level, event, fields) => events.push({ level, event, fields }),
  });
  await lifecycle.cleanupNow();

  assert.equal(transport.closeCalls, 1);
  assert.equal(lifecycle.size, 0);
  assert.equal(
    events.some((entry) => (
      entry.level === "warn"
      && entry.event === "mcp_session_close_failed"
      && entry.fields.reason === "pre_use_timeout"
      && entry.fields.error === "synthetic close failure"
    )),
    true,
  );
  await lifecycle.close();
}

async function testPressureWarningCanReset(): Promise<void> {
  const events: LoggedEvent[] = [];
  const lifecycle = new McpSessionLifecycle<FakeTransport>({
    warningThresholds: [2],
    log: (level, event, fields) => events.push({ level, event, fields }),
  });

  lifecycle.register("pressure-a", new FakeTransport());
  lifecycle.register("pressure-b", new FakeTransport());
  assert.equal(events.filter((entry) => entry.event === "mcp_session_pressure").length, 1);

  lifecycle.remove("pressure-a", "transport_close");
  await lifecycle.cleanupNow();
  lifecycle.register("pressure-c", new FakeTransport());
  assert.equal(events.filter((entry) => entry.event === "mcp_session_pressure").length, 2);
  await lifecycle.close();
}

function testOpenAiClientDetection(): void {
  assert.equal(isOpenAiMcpClient({ clientName: "OpenAI-MCP" }), true);
  assert.equal(isOpenAiMcpClient({ userAgent: "openai-mcp/1.0" }), true);
  assert.equal(isOpenAiMcpClient({ clientName: "other", userAgent: "other/1.0" }), false);
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return `http://127.0.0.1:${address.port}`;
}

async function getAndDrain(url: string): Promise<void> {
  await withTimeout(new Promise<void>((resolve, reject) => {
    const request = httpGet(url, (response) => {
      response.once("error", reject);
      response.resume();
      response.once("end", resolve);
    });
    request.once("error", reject);
  }));
}

async function closeHttpServer(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T | PromiseLike<T>): void;
  reject(reason?: unknown): void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs = 5_000): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error(`Timed out after ${timeoutMs}ms.`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}
