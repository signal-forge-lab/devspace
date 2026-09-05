import assert from "node:assert/strict";
import {
  MAX_WORKSPACE_ACTION_COMMAND_PREVIEW_CHARACTERS,
  MAX_WORKSPACE_ACTION_STEPS,
  WorkspaceActionPlanResolutionError,
  compileWorkspaceActionPlan,
  pendingWorkspaceActionSteps,
  processStep,
  workspaceActionSteps,
  writeJsonStep,
} from "./workspace-action-plans.js";

const plan = workspaceActionSteps([
  processStep("first", "First", "node", ["--version"]),
  processStep("second", "Second", "git", ["--version"]),
]);
assert.equal(plan.kind, "steps");
assert.deepEqual(plan.steps.map((step) => step.id), ["first", "second"]);
assert.equal(compileWorkspaceActionPlan(plan), "node --version && git --version");
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
  () => workspaceActionSteps([]),
  /at least one step/,
);
assert.throws(
  () => workspaceActionSteps([
    processStep("duplicate", "One", "node", ["--version"]),
    processStep("duplicate", "Two", "git", ["--version"]),
  ]),
  /Duplicate workspace action step id/,
);

assert.throws(
  () => workspaceActionSteps(Array.from(
    { length: MAX_WORKSPACE_ACTION_STEPS + 1 },
    (_, index) => processStep(`step-${index}`, `Step ${index}`, "node", ["--version"]),
  )),
  (error: unknown) => {
    assert.ok(error instanceof WorkspaceActionPlanResolutionError);
    assert.equal(error.kind, "action_plan_too_large");
    return true;
  },
);

assert.throws(
  () => compileWorkspaceActionPlan(workspaceActionSteps([
    processStep(
      "oversized",
      "Oversized",
      "node",
      ["x".repeat(MAX_WORKSPACE_ACTION_COMMAND_PREVIEW_CHARACTERS + 1)],
    ),
  ])),
  (error: unknown) => {
    assert.ok(error instanceof WorkspaceActionPlanResolutionError);
    assert.equal(error.kind, "action_plan_too_large");
    return true;
  },
);
