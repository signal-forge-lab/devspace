import assert from "node:assert/strict";
import { IdleResourceRegistry } from "./idle-resource-registry.js";

let now = 1_000;
const closed: string[] = [];
const registry = new IdleResourceRegistry<{ name: string; close(): void }>({
  maxEntries: 2,
  idleTtlMs: 100,
  cleanupIntervalMs: 60_000,
  now: () => now,
});

registry.set("a", { name: "a", close: () => closed.push("a") });
now += 10;
registry.set("b", { name: "b", close: () => closed.push("b") });
now += 10;
assert.equal(registry.get("a")?.name, "a");
now += 10;
registry.set("c", { name: "c", close: () => closed.push("c") });
assert.deepEqual(closed, ["b"]);
assert.equal(registry.get("b"), undefined);
assert.equal(registry.size, 2);

now += 200;
assert.equal(registry.cleanup(), 2);
assert.deepEqual(closed.sort(), ["a", "b", "c"]);
registry.closeAll();
