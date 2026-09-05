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
assert.equal(registry.beginRequest("active", ["tools/call"]), activeTransport);
assert.equal(registry.stats().activeRequests, 1);
assert.equal(registry.endRequest("active"), true);
assert.equal(registry.stats().activeRequests, 0);

const initializingTransport = createTransport();
registry.register("initializing", initializingTransport, {}, { requestActive: true });
assert.equal(registry.stats().activeRequests, 1);
assert.equal(registry.endRequest("initializing"), true);
registry.remove("initializing");
now = 2_000;

const idleResults = await registry.closeIdle(1_500);
assert.deepEqual(idleResults, [{ sessionId: "stale" }]);
assert.equal(staleTransport.closeCalls, 1);
assert.equal(activeTransport.closeCalls, 0);
assert.equal(registry.size, 1);
assert.equal(registry.beginRequest("stale"), undefined);
assert.equal(registry.beginRequest("active"), activeTransport);
assert.equal(registry.endRequest("active"), true);

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
observed.register(
  "discovery",
  discoveryTransport,
  {
    clientName: "openai-mcp",
    protocolVersion: "2025-06-18",
  },
  { oneShotCleanupEligible: true },
);
observed.register("operational", operationalTransport, {
  clientName: "codex",
  protocolVersion: "2025-06-18",
});
observed.beginRequest("handshake", ["notifications/initialized"]);
observed.endRequest("handshake");
observed.beginRequest("discovery", ["notifications/initialized", "tools/list"]);
observed.endRequest("discovery");
observed.beginRequest("operational", ["http/get", "tools/list", "tools/call", "tools/call"]);
observed.endRequest("operational");

const observedSnapshot = observed.snapshot(4);
assert.equal(observedSnapshot.stats.active, 4);
assert.equal(observedSnapshot.recent.length, 4);
assert.equal(observedSnapshot.recent[0]?.clientName, "chatgpt");
assert.equal(observedSnapshot.recent.some((session) => session.state === "operational"), true);
assert.equal(observedSnapshot.recent.some((session) => session.toolCalls === 2), true);

assert.deepEqual(observed.stats(), {
  active: 4,
  activeRequests: 0,
  initializedOnly: 1,
  handshakeOnly: 1,
  discoveryOnly: 1,
  operational: 1,
  toolCallSessions: 1,
  oneShotCleanupCandidates: 0,
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
  clientNames: { chatgpt: 2, codex: 1, "openai-mcp": 1 },
  protocolVersions: { "2025-06-18": 4 },
});

now += 15 * 60 * 1_000;
const preUseResults = await observed.closePreUse(15 * 60 * 1_000);
assert.deepEqual(preUseResults.map((result) => result.sessionId).sort(), [
  "discovery",
  "handshake",
  "initialized-only",
]);
assert.equal(initializedOnlyTransport.closeCalls, 1);
assert.equal(handshakeTransport.closeCalls, 1);
assert.equal(discoveryTransport.closeCalls, 1);
assert.equal(operationalTransport.closeCalls, 0);
assert.equal(observed.stats().active, 1);
assert.equal(observed.stats().totalClosed, 3);

now = 100_000;
const oneShotRegistry = new McpSessionRegistry<FakeTransport>({ now: () => now });
const activeOneShotTransport = createTransport();
const reusableTransport = createTransport();
const retainedOtherClientTransport = createTransport();
oneShotRegistry.register("active-one-shot", activeOneShotTransport, {}, { oneShotCleanupEligible: true });
oneShotRegistry.register("reused", reusableTransport, {}, { oneShotCleanupEligible: true });
oneShotRegistry.register("other-client", retainedOtherClientTransport);
assert.equal(oneShotRegistry.beginRequest("active-one-shot", ["tools/call"]), activeOneShotTransport);
assert.equal(oneShotRegistry.beginRequest("reused", ["tools/call"]), reusableTransport);
assert.equal(oneShotRegistry.endRequest("reused"), true);
assert.equal(oneShotRegistry.beginRequest("other-client", ["tools/call"]), retainedOtherClientTransport);
assert.equal(oneShotRegistry.endRequest("other-client"), true);
now += 1_000;
assert.equal(oneShotRegistry.beginRequest("reused", ["tools/call"]), reusableTransport);
assert.equal(oneShotRegistry.endRequest("reused"), true);

now += 5 * 60 * 1_000;
assert.deepEqual(await oneShotRegistry.closeOneShot(5 * 60 * 1_000), []);
assert.equal(activeOneShotTransport.closeCalls, 0);
assert.equal(reusableTransport.closeCalls, 0);
assert.equal(retainedOtherClientTransport.closeCalls, 0);
assert.equal(oneShotRegistry.stats().activeRequests, 1);
assert.equal(oneShotRegistry.stats().oneShotCleanupCandidates, 1);
assert.equal(oneShotRegistry.stats().reusedToolCallSessions, 1);

assert.equal(oneShotRegistry.endRequest("active-one-shot"), true);
now += 5 * 60 * 1_000;
const oneShotResults = await oneShotRegistry.closeOneShot(5 * 60 * 1_000);
assert.deepEqual(oneShotResults, [{ sessionId: "active-one-shot" }]);
assert.equal(activeOneShotTransport.closeCalls, 1);
assert.equal(reusableTransport.closeCalls, 0);
assert.equal(retainedOtherClientTransport.closeCalls, 0);
assert.equal(oneShotRegistry.size, 2);

now += 24 * 60 * 60 * 1_000;
assert.deepEqual(
  (await oneShotRegistry.closeIdle(24 * 60 * 60 * 1_000)).map((result) => result.sessionId).sort(),
  ["other-client", "reused"],
);
assert.equal(reusableTransport.closeCalls, 1);
assert.equal(retainedOtherClientTransport.closeCalls, 1);

now = 200_000;
const activeIdleRegistry = new McpSessionRegistry<FakeTransport>({ now: () => now });
const activeIdleTransport = createTransport();
activeIdleRegistry.register("active-idle", activeIdleTransport, {}, { oneShotCleanupEligible: true });
activeIdleRegistry.beginRequest("active-idle", ["tools/call"]);
now += 48 * 60 * 60 * 1_000;
assert.deepEqual(await activeIdleRegistry.closeOneShot(1), []);
assert.deepEqual(await activeIdleRegistry.closeIdle(1), []);
assert.equal(activeIdleTransport.closeCalls, 0);
assert.equal(activeIdleRegistry.endRequest("active-idle"), true);
now += 1;
assert.deepEqual(await activeIdleRegistry.closeOneShot(1), [{ sessionId: "active-idle" }]);
assert.equal(activeIdleTransport.closeCalls, 1);

now = 300_000;
const bulkRegistry = new McpSessionRegistry<FakeTransport>({ now: () => now });
const bulkTransports = Array.from({ length: 3_000 }, () => createTransport());
for (const [index, transport] of bulkTransports.entries()) {
  const sessionId = `bulk-${index}`;
  bulkRegistry.register(sessionId, transport, {}, { oneShotCleanupEligible: true });
  bulkRegistry.beginRequest(sessionId, ["tools/call"]);
  bulkRegistry.endRequest(sessionId);
}
assert.equal(bulkRegistry.size, 3_000);
assert.equal(bulkRegistry.stats().oneShotCleanupCandidates, 3_000);
now += 5 * 60 * 1_000;
const bulkResults = await bulkRegistry.closeOneShot(5 * 60 * 1_000);
assert.equal(bulkResults.length, 3_000);
assert.equal(bulkRegistry.size, 0);
assert.equal(bulkRegistry.stats().totalClosed, 3_000);
assert.equal(bulkTransports.every((transport) => transport.closeCalls === 1), true);
