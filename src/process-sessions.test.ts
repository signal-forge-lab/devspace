import assert from "node:assert/strict";
import { HeadTailBuffer, ProcessSessionManager } from "./process-sessions.js";
import { workspacePathRedactions } from "./path-redaction.js";
import { pendingWorkspaceActionSteps, shellSteps } from "./workspace-action-plans.js";

const smallBuffer = new HeadTailBuffer(100);
smallBuffer.append("hello\n");
assert.deepEqual(smallBuffer.drain(100), { output: "hello\n", truncated: false });
assert.deepEqual(smallBuffer.drain(100), { output: "", truncated: false });

const headTail = new HeadTailBuffer(10);
headTail.append("start-middle-end");
const headTailResult = headTail.drain(1_000);
assert.equal(headTailResult.truncated, true);
assert.match(headTailResult.output, /^start/);
assert.match(headTailResult.output, /e-end$/);
assert.match(headTailResult.output, /characters omitted/);

const responseLimited = new HeadTailBuffer(100);
responseLimited.append("abcdef".repeat(20));
const responseLimitedResult = responseLimited.drain(40);
assert.equal(responseLimitedResult.truncated, true);
assert.match(responseLimitedResult.output, /^abc/);
assert.match(responseLimitedResult.output, /def$/);

const unicodeBuffer = new HeadTailBuffer(4);
unicodeBuffer.append("a🙂b🙂c");
const unicodeResult = unicodeBuffer.drain(1_000);
assert.equal(unicodeResult.truncated, true);
assert.match(unicodeResult.output, /^a🙂/);
assert.match(unicodeResult.output, /🙂c$/);

const manager = new ProcessSessionManager({
  maxBufferCharacters: 1_024,
  completedSessionTtlMs: 1_000,
});

const node = process.platform === "win32"
  ? `"${process.execPath}"`
  : JSON.stringify(process.execPath);

const foreground = await manager.start({
  workspaceId: "workspace-a",
  cwd: process.cwd(),
  command: `${node} -e "console.log('foreground')"`,
  yieldTimeMs: 2_000,
});
assert.equal(foreground.running, false);
assert.equal(foreground.exitCode, 0);
assert.match(foreground.output, /foreground/);
assert.equal(foreground.sessionId, undefined);

const redactedForeground = await manager.start({
  workspaceId: "workspace-a",
  cwd: process.cwd(),
  command: `${node} -e "console.log(process.cwd())"`,
  workspaceRoot: process.cwd(),
  outputRedactions: workspacePathRedactions(process.cwd()),
  yieldTimeMs: 2_000,
});
assert.equal(redactedForeground.running, false);
assert.equal(redactedForeground.exitCode, 0);
assert.equal(redactedForeground.output.trim(), "<workspace>");

const statusOnly = await manager.start({
  workspaceId: "workspace-a",
  cwd: process.cwd(),
  command: `${node} -e "console.log('sensitive-path:C:/Users/example/project/file.py')"`,
  outputMode: "status",
  yieldTimeMs: 2_000,
});
assert.equal(statusOnly.running, false);
assert.equal(statusOnly.exitCode, 0);
assert.equal(statusOnly.output, "");
assert.equal(statusOnly.outputTruncated, false);
assert.equal(statusOnly.outputSuppressed, true);

const statusOnlyBackground = await manager.start({
  workspaceId: "workspace-a",
  cwd: process.cwd(),
  command: `${node} -e "setTimeout(() => console.log('sensitive-later:C:/Users/example/project/file.py'), 100)"`,
  outputMode: "status",
  yieldTimeMs: 5,
});
assert.equal(statusOnlyBackground.running, true);
assert.ok(statusOnlyBackground.sessionId);
assert.equal(statusOnlyBackground.output, "");
assert.equal(statusOnlyBackground.outputSuppressed, true);

const statusOnlyCompleted = await manager.write({
  workspaceId: "workspace-a",
  sessionId: statusOnlyBackground.sessionId,
  yieldTimeMs: 2_000,
});
assert.equal(statusOnlyCompleted.running, false);
assert.equal(statusOnlyCompleted.exitCode, 0);
assert.equal(statusOnlyCompleted.output, "");
assert.equal(statusOnlyCompleted.outputSuppressed, true);

let statusOnlyBufferedCharacters = 0;
const statusOnlyBufferProbe = new ProcessSessionManager({
  onBufferAppend: (output) => {
    statusOnlyBufferedCharacters += output.length;
  },
});
const statusOnlyUnbuffered = await statusOnlyBufferProbe.start({
  workspaceId: "workspace-a",
  cwd: process.cwd(),
  command: `${node} -e "console.log('x'.repeat(10000))"`,
  outputMode: "status",
  yieldTimeMs: 2_000,
});
assert.equal(statusOnlyUnbuffered.running, false);
assert.equal(statusOnlyUnbuffered.outputSuppressed, true);
assert.equal(statusOnlyBufferedCharacters, 0);
statusOnlyBufferProbe.shutdown();

const environment = await manager.start({
  workspaceId: "workspace-a",
  workspaceRoot: "/tmp/devspace-workspace-a",
  cwd: process.cwd(),
  command: `${node} -e "console.log([process.env.NO_COLOR, process.env.TERM, process.env.PAGER, process.env.GIT_PAGER, process.env.GH_PAGER, process.env.CODEX_CI, process.env.DEVSPACE_WORKSPACE_ID, process.env.DEVSPACE_WORKSPACE_ROOT].join(','))"`,
  yieldTimeMs: 2_000,
});
assert.equal(environment.running, false);
assert.match(environment.output, /1,dumb,cat,cat,cat,1,workspace-a,\/tmp\/devspace-workspace-a/);

const previousOwnerToken = process.env.DEVSPACE_OAUTH_OWNER_TOKEN;
const previousTestToken = process.env.WORKBRIDGE_TEST_TOKEN;
const previousAllowedValue = process.env.WORKBRIDGE_TEST_VALUE;
const previousAllowlist = process.env.DEVSPACE_CHILD_ENV_ALLOWLIST;
process.env.DEVSPACE_OAUTH_OWNER_TOKEN = "owner-secret";
process.env.WORKBRIDGE_TEST_TOKEN = "hidden-token";
process.env.WORKBRIDGE_TEST_VALUE = "visible-value";
process.env.DEVSPACE_CHILD_ENV_ALLOWLIST = "WORKBRIDGE_TEST_VALUE,DEVSPACE_OAUTH_OWNER_TOKEN";
try {
  const filteredEnvironment = await manager.start({
    workspaceId: "workspace-a",
    cwd: process.cwd(),
    command: `${node} -e "console.log([process.env.DEVSPACE_OAUTH_OWNER_TOKEN, process.env.WORKBRIDGE_TEST_TOKEN, process.env.WORKBRIDGE_TEST_VALUE].join(','))"`,
    yieldTimeMs: 2_000,
  });
  assert.equal(filteredEnvironment.running, false);
  assert.match(filteredEnvironment.output, /^,,visible-value\s*$/);
} finally {
  restoreEnvironment("DEVSPACE_OAUTH_OWNER_TOKEN", previousOwnerToken);
  restoreEnvironment("WORKBRIDGE_TEST_TOKEN", previousTestToken);
  restoreEnvironment("WORKBRIDGE_TEST_VALUE", previousAllowedValue);
  restoreEnvironment("DEVSPACE_CHILD_ENV_ALLOWLIST", previousAllowlist);
}

const background = await manager.start({
  workspaceId: "workspace-a",
  cwd: process.cwd(),
  command: `${node} -e "setTimeout(() => console.log('finished'), 100)"`,
  yieldTimeMs: 5,
});
assert.equal(background.running, true);
assert.ok(background.sessionId);
assert.equal(typeof background.sessionId, "number");

await assert.rejects(
  manager.write({
    workspaceId: "workspace-b",
    sessionId: background.sessionId,
    yieldTimeMs: 1,
  }),
  /does not belong to workspace/,
);

const completed = await manager.write({
  workspaceId: "workspace-a",
  sessionId: background.sessionId,
  yieldTimeMs: 2_000,
});
assert.equal(completed.running, false);
assert.equal(completed.exitCode, 0);
assert.match(completed.output, /finished/);

const actionPlan = shellSteps([
  {
    id: "first",
    label: "First action step",
    command: `${node} -e "setTimeout(() => console.log('action-first'), 100)"`,
  },
  {
    id: "second",
    label: "Second action step",
    command: `${node} -e "console.log('action-second')"`,
  },
]);
const actionBackground = await manager.startPlan({
  workspaceId: "workspace-a",
  cwd: process.cwd(),
  plan: actionPlan,
  yieldTimeMs: 5,
  context: {
    kind: "workspace_action",
    contractVersion: 2,
    action: "workspace_verify",
    preset: "standard",
    profile: "workbridge",
    policy: ["workspace_modify", "long_running"],
    commandPreview: "workspace verification",
    profileEvidence: ["test profile evidence"],
    warnings: ["test warning"],
    artifacts: [],
    steps: pendingWorkspaceActionSteps(actionPlan),
  },
});
assert.equal(actionBackground.running, true);
assert.ok(actionBackground.sessionId);
assert.equal(actionBackground.context?.kind, "workspace_action");
assert.equal(actionBackground.context?.action, "workspace_verify");
assert.equal(actionBackground.context?.profile, "workbridge");
assert.equal(actionBackground.context?.steps[0]?.status, "running");
assert.equal(actionBackground.context?.steps[1]?.status, "pending");

const actionCompleted = await manager.write({
  workspaceId: "workspace-a",
  sessionId: actionBackground.sessionId,
  yieldTimeMs: 2_000,
});
assert.equal(actionCompleted.running, false);
assert.equal(actionCompleted.exitCode, 0);
assert.equal(actionCompleted.context?.kind, "workspace_action");
assert.equal(actionCompleted.context?.action, "workspace_verify");
assert.equal(actionCompleted.context?.profile, "workbridge");
assert.deepEqual(actionCompleted.context?.policy, ["workspace_modify", "long_running"]);
assert.deepEqual(actionCompleted.context?.profileEvidence, ["test profile evidence"]);
assert.deepEqual(actionCompleted.context?.warnings, ["test warning"]);
assert.deepEqual(
  actionCompleted.context?.steps.map((step) => step.status),
  ["completed", "completed"],
);
assert.match(actionCompleted.output, /action-first/);
assert.match(actionCompleted.output, /action-second/);

const failingPlan = shellSteps([
  {
    id: "pass",
    label: "Passing step",
    command: `${node} -e "console.log('pass')"`,
  },
  {
    id: "fail",
    label: "Failing step",
    command: `${node} -e "process.exit(7)"`,
  },
  {
    id: "after",
    label: "Skipped step",
    command: `${node} -e "console.log('should-not-run')"`,
  },
]);
const failedAction = await manager.startPlan({
  workspaceId: "workspace-a",
  cwd: process.cwd(),
  plan: failingPlan,
  yieldTimeMs: 2_000,
  context: {
    kind: "workspace_action",
    contractVersion: 2,
    action: "test_action",
    preset: "standard",
    policy: ["workspace_modify"],
    profileEvidence: [],
    warnings: [],
    artifacts: [],
    steps: pendingWorkspaceActionSteps(failingPlan),
  },
});
assert.equal(failedAction.running, false);
assert.equal(failedAction.exitCode, 7);
assert.deepEqual(
  failedAction.context?.steps.map((step) => step.status),
  ["completed", "failed", "skipped"],
);
assert.equal(failedAction.context?.steps[1]?.exitCode, 7);
assert.doesNotMatch(failedAction.output, /should-not-run/);

const cancellablePlan = shellSteps([
  {
    id: "wait",
    label: "Waiting step",
    command: `${node} -e "setInterval(() => console.log('action-tick'), 10)"`,
  },
  {
    id: "after-cancel",
    label: "Step after cancellation",
    command: `${node} -e "console.log('after-cancel')"`,
  },
]);
const cancellableAction = await manager.startPlan({
  workspaceId: "workspace-a",
  cwd: process.cwd(),
  plan: cancellablePlan,
  yieldTimeMs: 50,
  context: {
    kind: "workspace_action",
    contractVersion: 2,
    action: "test_action",
    preset: "standard",
    policy: ["workspace_modify", "long_running"],
    profileEvidence: [],
    warnings: [],
    artifacts: [],
    steps: pendingWorkspaceActionSteps(cancellablePlan),
  },
});
assert.equal(cancellableAction.running, true);
assert.ok(cancellableAction.sessionId);
const cancelledAction = await manager.write({
  workspaceId: "workspace-a",
  sessionId: cancellableAction.sessionId,
  chars: "\u0003",
  yieldTimeMs: 2_000,
});
assert.equal(cancelledAction.running, false);
assert.equal(cancelledAction.cancelled, true);
assert.deepEqual(
  cancelledAction.context?.steps.map((step) => step.status),
  ["cancelled", "skipped"],
);

const interactive = await manager.start({
  workspaceId: "workspace-a",
  cwd: process.cwd(),
  command: `${node} -e "process.stdin.once('data', data => { console.log('input:' + data.toString().trim()); process.exit(0); })"`,
  yieldTimeMs: 5,
});
assert.equal(interactive.running, true);
assert.ok(interactive.sessionId);
assert.equal(typeof interactive.sessionId, "number");

const inputResult = await manager.write({
  workspaceId: "workspace-a",
  sessionId: interactive.sessionId,
  chars: "hello\n",
  yieldTimeMs: 2_000,
});
assert.equal(inputResult.running, false);
assert.match(inputResult.output, /input:hello/);

const defaultInteractive = await manager.start({
  workspaceId: "workspace-a",
  cwd: process.cwd(),
  command: `${node} -e "process.stdin.once('data', data => setTimeout(() => { console.log('default-input:' + data.toString().trim()); process.exit(0); }, 100))"`,
  yieldTimeMs: 5,
});
assert.equal(defaultInteractive.running, true);
assert.ok(defaultInteractive.sessionId);

const defaultInputResult = await manager.write({
  workspaceId: "workspace-a",
  sessionId: defaultInteractive.sessionId,
  chars: "hello\n",
});
assert.equal(defaultInputResult.running, false);
assert.match(defaultInputResult.output, /default-input:hello/);

const noisyInteractive = await manager.start({
  workspaceId: "workspace-a",
  cwd: process.cwd(),
  command: `${node} -e "setInterval(() => console.log('tick'), 10); process.stdin.once('data', data => { console.log('input:' + data.toString().trim()); process.exit(0); })"`,
  yieldTimeMs: 100,
});
assert.equal(noisyInteractive.running, true);
assert.ok(noisyInteractive.sessionId);

await new Promise((resolve) => setTimeout(resolve, 50));
const noisyInputResult = await manager.write({
  workspaceId: "workspace-a",
  sessionId: noisyInteractive.sessionId,
  chars: "hello\n",
  yieldTimeMs: 2_000,
});
assert.equal(noisyInputResult.running, false);
assert.match(noisyInputResult.output, /input:hello/);

const interruptible = await manager.start({
  workspaceId: "workspace-a",
  cwd: process.cwd(),
  command: `${node} -e "setInterval(() => console.log('tick'), 10)"`,
  yieldTimeMs: 100,
});
assert.equal(interruptible.running, true);
assert.ok(interruptible.sessionId);

await new Promise((resolve) => setTimeout(resolve, 50));
const interrupted = await manager.write({
  workspaceId: "workspace-a",
  sessionId: interruptible.sessionId,
  chars: "\u0003",
  yieldTimeMs: 2_000,
});
assert.equal(interrupted.running, false);
assert.equal(interrupted.cancelled, true);
if (process.platform !== "win32") assert.equal(interrupted.signal, "SIGINT");

let buffered = await manager.start({
  workspaceId: "workspace-a",
  cwd: process.cwd(),
  command: `${node} -e "console.log('x'.repeat(5000)); setTimeout(() => {}, 100)"`,
  yieldTimeMs: 50,
  maxOutputTokens: 100,
});
if (!buffered.outputTruncated && buffered.sessionId) {
  buffered = await manager.write({
    workspaceId: "workspace-a",
    sessionId: buffered.sessionId,
    yieldTimeMs: 2_000,
    maxOutputTokens: 100,
  });
}
assert.equal(buffered.outputTruncated, true);
if (buffered.sessionId) manager.terminate("workspace-a", buffered.sessionId);

try {
  if (process.platform === "win32") {
    const pty = await manager.start({
      workspaceId: "workspace-a",
      cwd: process.cwd(),
      command: "echo pty-ok",
      tty: true,
      yieldTimeMs: 10_000,
    });
    assert.equal(pty.running, false);
    assert.match(pty.output, /pty-ok/);
  } else {
    const pty = await manager.start({
      workspaceId: "workspace-a",
      cwd: process.cwd(),
      command: `${node} -e "setTimeout(() => console.log('columns:' + process.stdout.columns), 250)"`,
      tty: true,
      columns: 80,
      rows: 24,
      yieldTimeMs: 10,
    });
    assert.equal(pty.running, true);
    assert.ok(pty.sessionId);

    const resizedPty = await manager.write({
      workspaceId: "workspace-a",
      sessionId: pty.sessionId,
      columns: 120,
      rows: 30,
      yieldTimeMs: 2_000,
    });
    assert.equal(resizedPty.running, false);
    assert.match(resizedPty.output, /columns:120/);
  }
} finally {
  manager.shutdown();
}

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
