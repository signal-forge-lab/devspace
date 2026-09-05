import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SoftPauseController } from "./soft-pause.js";

const stateDir = mkdtempSync(join(tmpdir(), "workbridge-soft-pause-test-"));
const controller = new SoftPauseController(stateDir);
const original = {
  content: [{ type: "text" as const, text: "Tool completed." }],
  _meta: { existing: true },
  structuredContent: { result: "Tool completed.", count: 1 },
};

assert.equal(controller.status(), undefined);
assert.equal(controller.decorateToolResult(original), original);

const requested = controller.request("  PC restart\nwhen convenient  ");
assert.equal(requested.reason, "PC restart when convenient");
assert.equal(controller.status()?.reason, "PC restart when convenient");

const decorated = controller.decorateToolResult(original);
assert.equal(decorated.content.length, 2);
assert.match(decorated.content[1]?.text ?? "", /WORKBRIDGE_SOFT_PAUSE_REQUESTED/);
assert.match(decorated.content[1]?.text ?? "", /作業を一時中断しました/);
assert.equal(decorated._meta.existing, true);
assert.equal(
  ((decorated._meta as Record<string, unknown>).workbridgeSoftPause as { state?: string }).state,
  "requested",
);
assert.match(decorated.structuredContent.result, /WORKBRIDGE_SOFT_PAUSE_REQUESTED/);
assert.equal(decorated.structuredContent.count, 1);

assert.equal(controller.clear(), true);
assert.equal(controller.status(), undefined);
assert.equal(controller.clear(), false);

console.log("soft-pause tests passed");
