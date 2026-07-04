import { strict as assert } from "node:assert";
import { execFile } from "node:child_process";
import { mkdtemp, writeFile, mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const root = await mkdtemp(join(tmpdir(), "devspace-log-analysis-test-"));
const logs = join(root, "logs");
const workflowEvents = join(root, "workflow-events");
await mkdir(logs, { recursive: true });
await mkdir(workflowEvents, { recursive: true });

await writeFile(
  join(logs, "devspace.jsonl"),
  [
    JSON.stringify({ ts: "2026-07-01T00:00:00.000Z", event: "tool_call", tool: "devspace_verify", operation: "verify_git_status_check", success: true, durationMs: 12, resultCharacters: 34 }),
    JSON.stringify({ ts: "2026-07-01T00:00:01.000Z", event: "tool_call", tool: "bash", operation: "run", success: false, durationMs: 5, error: "MCP output validation invalid_type" }),
    JSON.stringify({ ts: "2026-07-01T00:00:01.500Z", event: "tool_call", tool: "apply_structured_edit", operation: "apply_structured_edit", success: true, durationMs: 6, resultCharacters: 42 }),
    JSON.stringify({ ts: "2026-07-01T00:00:01.600Z", event: "tool_call", tool: "apply_unified_patch", operation: "apply_unified_patch", success: true, durationMs: 8, resultCharacters: 64 }),
    JSON.stringify({ ts: "2026-07-01T00:00:01.700Z", event: "tool_trace_summary", traceId: "trace_1", retriesAfterFailure: 1, retries: 1 }),
  ].join("\n") + "\n",
  "utf8",
);

await writeFile(
  join(workflowEvents, "events.jsonl"),
  JSON.stringify({ eventId: "wfe_test", createdAt: "2026-07-01T00:00:02.000Z", workflowMode: "router", event: "devspace_verify", action: "git_status_check", tool: "devspace_verify", status: "ok", outputChars: 34, durationMs: 9 }) + "\n",
  "utf8",
);

const { stdout } = await execFileAsync("node", [resolve("scripts/analyze-devspace-logs.mjs"), logs, workflowEvents, "--json"], { cwd: resolve(".") });
const report = JSON.parse(stdout);

assert.equal(report.workflowEvents.count, 1);
assert.equal(report.workflowEvents.byMode[0]?.key, "router");
assert.equal(report.verifyProfiles.totalCalls, 2);
assert.equal(report.verifyProfiles.items[0]?.profile, "git_status_check");
assert.equal(report.failureCategories.total, 1);
assert.equal(report.failureCategories.categories[0]?.key, "schema_validation");
assert.equal(report.failureCategories.improvementActions[0]?.key, "switch_to_structured_schema");
assert.equal(report.efficiencyMetrics.availableMetrics.bashToolCalls, 1);
assert.equal(report.efficiencyMetrics.availableMetrics.structuredEditCalls, 1);
assert.equal(report.efficiencyMetrics.availableMetrics.unifiedPatchCalls, 1);
assert.equal(report.efficiencyMetrics.availableMetrics.devspaceVerifyCalls, 2);
assert.equal(report.efficiencyMetrics.availableMetrics.incidentImprovementHintCount, 1);
assert.equal(report.efficiencyMetrics.availableMetrics.retryAfterFailureCount, 1);
assert.ok(report.efficiencyMetrics.unavailableMetrics.includes("hostFilteredCallsWithoutToolEvent"));

const htmlPath = join(root, "report.html");
await execFileAsync("node", [resolve("scripts/analyze-devspace-logs.mjs"), logs, workflowEvents, "--html", htmlPath], { cwd: resolve(".") });
const html = await readFile(htmlPath, "utf8");
assert.match(html, /Verify Profiles/);
assert.match(html, /Workflow Events/);
assert.match(html, /Failure Categories/);
assert.match(html, /Workflow Modes/);
assert.match(html, /Efficiency Summary KPI/);
assert.match(html, /Incident Improvement Hints/);
