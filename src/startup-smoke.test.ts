import { strict as assert } from "node:assert";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const { stdout } = await execFileAsync("node", ["scripts/smoke-devspace-runtime.mjs", "--quick", "--json"], { encoding: "utf8" });
const report = JSON.parse(stdout);

assert.equal(report.mode, "quick");
assert.equal(report.summary.localFailures, 0);
assert.ok(report.summary.localChecks >= 2);
assert.equal(report.summary.manualChecks, 6);
assert.ok(report.manualMcpChecks.some((check: { id: string }) => check.id === "build_profile"));
assert.ok(report.package.version);
