import assert from "node:assert/strict";
import {
  compileWorkspaceActionPlan,
  shellSteps,
} from "./workspace-action-plans.js";

const plan = shellSteps([
  { id: "first", label: "First", command: "echo first" },
  { id: "second", label: "Second", command: "echo second" },
]);
assert.equal(plan.kind, "shell_steps");
assert.deepEqual(plan.steps.map((step) => step.id), ["first", "second"]);
assert.equal(compileWorkspaceActionPlan(plan), "echo first && echo second");

assert.throws(
  () => shellSteps([]),
  /at least one step/,
);
assert.throws(
  () => shellSteps([
    { id: "duplicate", label: "One", command: "echo one" },
    { id: "duplicate", label: "Two", command: "echo two" },
  ]),
  /Duplicate workspace action step id/,
);
