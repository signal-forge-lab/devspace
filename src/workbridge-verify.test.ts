import { strict as assert } from "node:assert";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as z from "zod/v4";
import { WORKBRIDGE_VERIFY_PROFILES, workbridgeVerify } from "./workbridge-verify.js";
import type { Workspace } from "./workspaces.js";

const execFileAsync = promisify(execFile);


const verifyProfileSchema = z.enum(WORKBRIDGE_VERIFY_PROFILES);

const runtimeInfoSchema = z.object({
  appName: z.string(),
  appVersion: z.string(),
  gitCommit: z.string(),
  gitBranch: z.string(),
  buildSource: z.string(),
  processStartedAt: z.string(),
  processId: z.number(),
  nodeVersion: z.string(),
  platform: z.string(),
  cliEntryPath: z.string(),
  runtimeDistPath: z.string(),
  cwd: z.string(),
});
const commandResultSchema = z.object({
  label: z.string(),
  bin: z.string(),
  args: z.array(z.string()),
  status: z.enum(["ok", "failed", "timed_out"]),
  exitCode: z.union([z.number(), z.string()]).optional(),
  signal: z.string().optional(),
  durationMs: z.number(),
  stdoutChars: z.number(),
  stderrChars: z.number(),
  stdoutTail: z.string().optional(),
  stderrTail: z.string().optional(),
  stdoutOmitted: z.boolean(),
  stderrOmitted: z.boolean(),
  stdoutTruncated: z.boolean(),
  stderrTruncated: z.boolean(),
});
const mcpVerifyResultSchema = z.object({
  result: z.string(),
  status: z.enum(["ok", "failed", "timed_out"]),
  profile: verifyProfileSchema,
  workflowMode: z.enum(["baseline", "zip_first", "router", "zip_first_router"]).optional(),
  durationMs: z.number(),
  commandCount: z.number(),
  commands: z.array(commandResultSchema),
  summary: z.object({
    failedCommands: z.number(),
    timedOutCommands: z.number(),
    stdoutChars: z.number(),
    stderrChars: z.number(),
    outputOmitted: z.boolean(),
    outputTruncated: z.boolean(),
  }),
  runtimeInfo: runtimeInfoSchema,
});

function assertMcpSafe(value: unknown): void {
  assertNoNulls(value, "result");
  mcpVerifyResultSchema.parse(value);
}

function assertNoNulls(value: unknown, path: string): void {
  if (value === null) assert.fail(`Unexpected null at ${path}`);
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoNulls(item, `${path}[${index}]`));
    return;
  }
  if (typeof value === "object" && value) {
    for (const [key, child] of Object.entries(value)) assertNoNulls(child, `${path}.${key}`);
  }
}

function workspaceFor(root: string, id = "ws_verify_test"): Workspace {
  return {
    id,
    root,
    mode: "checkout",
    skills: [],
    skillDiagnostics: [],
    activatedSkillDirs: new Set(),
  };
}

const root = await mkdtemp(join(tmpdir(), "workbridge-verify-test-"));
await execFileAsync("git", ["init"], { cwd: root });
await writeFile(join(root, "README.md"), "# Verify\n", "utf8");
await execFileAsync("git", ["add", "README.md"], { cwd: root });

const workspace = workspaceFor(root);
const ok = await workbridgeVerify({ workspace, profile: "git_diff_check", workflowMode: "router", maxOutputChars: 1000 });
assert.equal(ok.status, "ok");
assert.equal(ok.profile, "git_diff_check");
assert.equal(ok.runtimeInfo.appVersion.length > 0, true);
assert.ok(ok.runtimeInfo.processStartedAt.length > 0);
assert.equal(ok.commandCount, 1);
assert.equal(ok.commands[0]?.status, "ok");
assert.equal(ok.commands[0]?.stdoutTail, undefined);
assert.equal(ok.commands[0]?.exitCode, 0);
assert.equal(ok.commands[0]?.signal, undefined);
assert.equal(ok.summary.outputOmitted, false);
assert.equal(ok.summary.outputTruncated, false);
assertMcpSafe(ok);

await writeFile(join(root, "UNTRACKED.md"), "untracked\n", "utf8");
const omitted = await workbridgeVerify({ workspace, profile: "git_status_check", maxOutputChars: 1000 });
assert.equal(omitted.status, "ok");
assert.equal(omitted.summary.outputOmitted, false);
assert.equal(omitted.commands[0]?.stdoutOmitted, false);
assert.ok(omitted.commands[0]?.stdoutTail);
assertMcpSafe(omitted);

for (let i = 0; i < 60; i += 1) {
  await writeFile(join(root, `UNTRACKED_${String(i).padStart(2, "0")}_very_long_file_name_for_tail_capture.md`), "x\n", "utf8");
}
const truncated = await workbridgeVerify({ workspace, profile: "git_status_check", maxOutputChars: 500 });
assert.equal(truncated.status, "ok");
assert.equal(truncated.summary.outputOmitted, false);
assert.equal(truncated.summary.outputTruncated, true);
assert.equal(truncated.commands[0]?.stdoutTruncated, true);
assert.ok(truncated.commands[0]?.stdoutTail);
assert.ok((truncated.commands[0]?.stdoutTail ?? "").length <= 250);
assertMcpSafe(truncated);

const nonGitRoot = await mkdtemp(join(tmpdir(), "workbridge-verify-non-git-"));
const failed = await workbridgeVerify({ workspace: workspaceFor(nonGitRoot, "ws_verify_failed"), profile: "git_diff_check", maxOutputChars: 1000 });
assert.equal(failed.status, "failed");
assert.equal(failed.summary.failedCommands, 1);
assert.ok(failed.commands[0]?.stderrTail || failed.commands[0]?.stdoutTail);
assertMcpSafe(failed);

let threw = false;
try {
  await workbridgeVerify({ workspace, profile: "git_diff_check", timeoutMs: 1 });
} catch (error) {
  threw = /timeoutMs/.test(error instanceof Error ? error.message : String(error));
}
assert.equal(threw, true);

const packageManagerSmoke = await workbridgeVerify({ workspace: workspaceFor(resolve("."), "ws_verify_project"), profile: "typecheck_only", maxOutputChars: 1000 });
assert.equal(packageManagerSmoke.status, "ok");
assert.equal(packageManagerSmoke.commands[0]?.label, "typecheck");
assertMcpSafe(packageManagerSmoke);
