import assert from "node:assert/strict";
import {
  MAX_WORKSPACE_ACTION_COMMAND_PREVIEW_CHARACTERS,
  MAX_WORKSPACE_ACTION_STEPS,
  WorkspaceActionPlanResolutionError,
  compileWorkspaceActionPlan,
  pendingWorkspaceActionSteps,
  processStep,
  shellSteps,
  workspaceActionSteps,
  writeJsonStep,
} from "./workspace-action-plans.js";

const plan = shellSteps([
  { id: "first", label: "First", command: "echo first" },
  { id: "second", label: "Second", command: "echo second" },
]);
assert.equal(plan.kind, "shell_steps");
assert.deepEqual(plan.steps.map((step) => step.id), ["first", "second"]);
assert.equal(compileWorkspaceActionPlan(plan), "echo first && echo second");
assert.deepEqual(pendingWorkspaceActionSteps(plan), [
  { id: "first", label: "First", status: "pending" },
  { id: "second", label: "Second", status: "pending" },
]);

const structuredPlan = workspaceActionSteps([
  processStep("process", "Process", "node", ["--test", "tests/日本 語.test.js"]),
  writeJsonStep("report", "Report", ".workbridge/reports/result.json", { ok: true }),
]);
assert.equal(
  compileWorkspaceActionPlan(structuredPlan),
  "node --test \"tests/日本 語.test.js\" && write-json .workbridge/reports/result.json",
);

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

assert.throws(
  () => shellSteps(Array.from({ length: MAX_WORKSPACE_ACTION_STEPS + 1 }, (_, index) => ({
    id: `step-${index}`,
    label: `Step ${index}`,
    command: "echo step",
  }))),
  (error: unknown) => {
    assert.ok(error instanceof WorkspaceActionPlanResolutionError);
    assert.equal(error.kind, "action_plan_too_large");
    return true;
  },
);

assert.throws(
  () => compileWorkspaceActionPlan(shellSteps([
    {
      id: "oversized",
      label: "Oversized",
      command: "x".repeat(MAX_WORKSPACE_ACTION_COMMAND_PREVIEW_CHARACTERS + 1),
    },
  ])),
  (error: unknown) => {
    assert.ok(error instanceof WorkspaceActionPlanResolutionError);
    assert.equal(error.kind, "action_plan_too_large");
    return true;
  },
);
