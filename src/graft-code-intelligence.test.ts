import assert from "node:assert/strict";
import { resolve } from "node:path";
import {
  createGraftActionPlan,
  graftGraphDir,
} from "./graft-code-intelligence.js";

const workspaceRoot = resolve("fixture-repo");
const stateDir = resolve("fixture-state");

const cold = createGraftActionPlan({
  action: "ask",
  parameters: {
    query: "where is workspace registration handled?",
    scopePath: "src",
    limit: 6,
  },
  workspaceRoot,
  stateDir,
  graphReady: false,
});
assert.equal(cold.graphDir, graftGraphDir(stateDir, workspaceRoot));
assert.equal(cold.plan.steps.length, 2);
assert.equal(cold.plan.steps[0]?.kind, "process");
assert.deepEqual(cold.plan.steps[0]?.args.slice(-2), ["build", workspaceRoot]);
assert.equal(cold.plan.steps[1]?.kind, "process");
assert.ok(cold.plan.steps[1]?.args.includes("ask"));
assert.ok(cold.plan.steps[1]?.args.includes("where is workspace registration handled?"));
assert.ok(cold.plan.steps[1]?.args.includes("--limit"));
assert.ok(cold.plan.steps[1]?.args.includes("6"));
assert.ok(cold.plan.steps[1]?.args.includes("--in"));
assert.ok(cold.plan.steps[1]?.args.includes("src"));

const warm = createGraftActionPlan({
  action: "callers",
  parameters: {
    symbol: "WorkspaceRegistry.openWorkspace",
    direction: "in",
    depth: "all",
  },
  workspaceRoot,
  stateDir,
  graphReady: true,
});
assert.equal(warm.plan.steps.length, 1);
assert.equal(warm.plan.steps[0]?.kind, "process");
assert.ok(warm.plan.steps[0]?.args.includes("callers"));
assert.ok(warm.plan.steps[0]?.args.includes("WorkspaceRegistry.openWorkspace"));
assert.ok(warm.plan.steps[0]?.args.includes("all"));

assert.throws(
  () => createGraftActionPlan({
    action: "skeleton",
    parameters: { file: "../outside.ts" },
    workspaceRoot,
    stateDir,
    graphReady: true,
  }),
  /stay inside the workspace/,
);
assert.throws(
  () => createGraftActionPlan({
    action: "ask",
    workspaceRoot,
    stateDir,
    graphReady: true,
  }),
  /query must be a non-empty string/,
);

console.log("graft code-intelligence tests passed");
