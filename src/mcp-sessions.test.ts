import assert from "node:assert/strict";
import { McpSessionRegistry } from "./mcp-sessions.js";

interface FakeTransport {
  closeCalls: number;
  close(): Promise<void>;
}

function createTransport(closeError?: Error): FakeTransport {
  return {
    closeCalls: 0,
    async close() {
      this.closeCalls += 1;
      if (closeError) throw closeError;
    },
  };
}

let now = 0;
const registry = new McpSessionRegistry<FakeTransport>({ now: () => now });
const staleTransport = createTransport();
const activeTransport = createTransport();

registry.register("stale", staleTransport);
now = 1_000;
registry.register("active", activeTransport);
now = 1_500;
assert.equal(registry.get("active", ["tools/call"]), activeTransport);
now = 2_000;

const idleResults = await registry.closeIdle(1_500);
assert.deepEqual(idleResults, [{ sessionId: "stale" }]);
assert.equal(staleTransport.closeCalls, 1);
assert.equal(activeTransport.closeCalls, 0);
assert.equal(registry.size, 1);
assert.equal(registry.get("stale"), undefined);
assert.equal(registry.get("active"), activeTransport);

const closeError = new Error("close failed");
const failingTransport = createTransport(closeError);
registry.register("failing", failingTransport);
now = 10_000;

const failingResults = await registry.closeIdle(1);
assert.equal(failingResults.length, 2);
assert.deepEqual(failingResults.map((result) => result.sessionId).sort(), ["active", "failing"]);
assert.equal(failingResults.find((result) => result.sessionId === "failing")?.error, closeError);
assert.equal(failingTransport.closeCalls, 1);
assert.equal(registry.size, 0);

const first = createTransport();
const second = createTransport();
registry.register("first", first);
registry.register("second", second);
registry.remove("first");

const shutdownResults = await registry.closeAll();
assert.deepEqual(shutdownResults, [{ sessionId: "second" }]);
assert.equal(first.closeCalls, 0);
assert.equal(second.closeCalls, 1);
assert.equal(registry.size, 0);

let finishDelayedClose: (() => void) | undefined;
let delayedCloseResolved = false;
const delayedTransport: FakeTransport = {
  closeCalls: 0,
  close() {
    this.closeCalls += 1;
    return new Promise<void>((resolve) => {
      finishDelayedClose = resolve;
    });
  },
};
registry.register("delayed", delayedTransport);
const delayedClose = registry.closeAll();
void delayedClose.then(() => {
  delayedCloseResolved = true;
});

await Promise.resolve();
assert.equal(delayedCloseResolved, false);
assert.equal(delayedTransport.closeCalls, 1);
finishDelayedClose?.();
await delayedClose;
assert.equal(delayedCloseResolved, true);
assert.equal(registry.size, 0);

now = 20_000;
const retained = new McpSessionRegistry<FakeTransport>({ now: () => now });
const retainedTransports = Array.from({ length: 64 }, () => createTransport());
for (const [index, transport] of retainedTransports.entries()) {
  retained.register(`retained-${index}`, transport);
  now += 1;
}
assert.equal(retained.size, 64);
assert.equal(retainedTransports.every((transport) => transport.closeCalls === 0), true);

const retainedResults = await retained.closeAll();
assert.equal(retainedResults.length, 64);
assert.equal(retainedTransports.every((transport) => transport.closeCalls === 1), true);

now = 30_000;
const observed = new McpSessionRegistry<FakeTransport>({ now: () => now });
const initializedOnlyTransport = createTransport();
const handshakeTransport = createTransport();
const discoveryTransport = createTransport();
const operationalTransport = createTransport();
observed.register("initialized-only", initializedOnlyTransport, {
  clientName: "chatgpt",
  protocolVersion: "2025-06-18",
});
observed.register("handshake", handshakeTransport, {
  clientName: "chatgpt",
  protocolVersion: "2025-06-18",
});
observed.register("discovery", discoveryTransport, {
  clientName: "chatgpt",
  protocolVersion: "2025-06-18",
});
observed.register("operational", operationalTransport, {
  clientName: "codex",
  protocolVersion: "2025-06-18",
});
observed.get("handshake", ["notifications/initialized"]);
observed.get("discovery", ["notifications/initialized", "tools/list"]);
observed.get("operational", ["http/get", "tools/list", "tools/call", "tools/call"]);

assert.deepEqual(observed.stats(), {
  active: 4,
  initializedOnly: 1,
  handshakeOnly: 1,
  discoveryOnly: 1,
  operational: 1,
  toolCallSessions: 1,
  reusedToolCallSessions: 1,
  maxToolCallsPerSession: 2,
  totalCreated: 4,
  totalClosed: 0,
  totalSubsequentRequests: 3,
  oldestAgeMs: 0,
  longestIdleMs: 0,
  requestMethods: {
    "notifications/initialized": 2,
    "tools/list": 2,
    "tools/call": 2,
    "http/get": 1,
  },
  clientNames: { chatgpt: 3, codex: 1 },
  protocolVersions: { "2025-06-18": 4 },
});

now += 15 * 60 * 1_000;
const preUseResults = await observed.closePreUse(15 * 60 * 1_000);
assert.deepEqual(preUseResults.map((result) => result.sessionId).sort(), ["handshake", "initialized-only"]);
assert.equal(initializedOnlyTransport.closeCalls, 1);
assert.equal(handshakeTransport.closeCalls, 1);
assert.equal(discoveryTransport.closeCalls, 0);
assert.equal(operationalTransport.closeCalls, 0);
assert.equal(observed.stats().active, 2);
assert.equal(observed.stats().totalClosed, 2);
