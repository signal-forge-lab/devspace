import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  allowedRootsIdentity,
  armLocalActionTrigger,
  canonicalLocalActionTriggerManifest,
  claimLocalActionTrigger,
  executeResolvedAction,
  loadLocalActionTriggerManifest,
  parseLocalActionTriggerWorkerArgs,
  resolveLocalActionTrigger,
  runLocalActionTriggerWorker,
  type LocalActionTriggerExecutionResult,
  type LocalActionTriggerManifest,
} from "./local-action-trigger.js";
import {
  loadWindowsLocalActionTriggerConfigSnapshot,
  scheduleWindowsLocalActionTrigger,
} from "./local-action-trigger-windows.js";
import type { ResolvedWorkspaceAction } from "./workspace-actions.js";

const root = await mkdtemp(join(tmpdir(), "workbridge-local-action-trigger-test-"));

try {
  const projectRoot = join(root, "project");
  const stateDir = join(root, "state");
  const manifestDir = join(projectRoot, "manifests");
  const evidenceDir = join(stateDir, "local-action-triggers", "evidence");
  await mkdir(manifestDir, { recursive: true });
  await mkdir(evidenceDir, { recursive: true });

  const config = {
    allowedRoots: [projectRoot],
    stateDir,
  };
  const baseManifest: LocalActionTriggerManifest = {
    schemaVersion: "workbridge_local_action_trigger_v1",
    triggerId: "d66-test-trigger",
    action: "ao_registered_python",
    preset: "help",
    workspaceRoot: projectRoot,
    allowedRootsSha256: allowedRootsIdentity(config.allowedRoots),
    parameters: {},
    expectedResolvedCommandSha256: "a".repeat(64),
    fireAtUtc: "2026-08-06T00:00:05.000Z",
    expiresAtUtc: "2026-08-06T00:01:05.000Z",
    evidencePath: join(evidenceDir, "d66-test-trigger.json"),
  };

  const manifestPath = join(manifestDir, "trigger.json");
  const canonical = canonicalLocalActionTriggerManifest(baseManifest);
  await writeFile(manifestPath, canonical.bytes);
  const loaded = await loadLocalActionTriggerManifest({
    manifestPath,
    expectedManifestSha256: canonical.sha256,
    config,
  });
  assert.deepEqual(loaded.manifest, baseManifest);
  assert.equal(loaded.manifestSha256, canonical.sha256);

  const freezeFirstManifest = canonicalLocalActionTriggerManifest({
    ...baseManifest,
    triggerId: "d66-freeze-first-trigger",
    preset: "freeze_first_execute",
  });
  const freezeFirstManifestPath = join(manifestDir, "freeze-first.json");
  await writeFile(freezeFirstManifestPath, freezeFirstManifest.bytes);
  const freezeFirstLoaded = await loadLocalActionTriggerManifest({
    manifestPath: freezeFirstManifestPath,
    expectedManifestSha256: freezeFirstManifest.sha256,
    config,
  });
  assert.equal(freezeFirstLoaded.manifest.preset, "freeze_first_execute");

  const nonCanonicalPath = join(manifestDir, "non-canonical.json");
  const nonCanonicalBytes = Buffer.from(`${JSON.stringify(baseManifest, null, 2)}\n`, "utf8");
  await writeFile(nonCanonicalPath, nonCanonicalBytes);
  await assert.rejects(
    loadLocalActionTriggerManifest({
      manifestPath: nonCanonicalPath,
      expectedManifestSha256: createHash("sha256").update(nonCanonicalBytes).digest("hex"),
      config,
    }),
    /canonical JSON/,
  );

  const unsafeManifest = {
    ...baseManifest,
    command: "calc.exe",
  } as LocalActionTriggerManifest & { command: string };
  const unsafe = canonicalLocalActionTriggerManifest(unsafeManifest);
  const unsafePath = join(manifestDir, "unsafe.json");
  await writeFile(unsafePath, unsafe.bytes);
  await assert.rejects(
    loadLocalActionTriggerManifest({
      manifestPath: unsafePath,
      expectedManifestSha256: unsafe.sha256,
      config,
    }),
    /unknown fields: command/,
  );

  const resolvedAction: ResolvedWorkspaceAction = {
    action: "ao_registered_python",
    preset: "help",
    parameters: {},
    command: "py -m tradingagents.ao_d60_registered_run --help",
    displayCommand: "py -m tradingagents.ao_d60_registered_run --help",
    description: "test",
    policy: ["read_only"],
    profile: "python",
    profileEvidence: [],
    warnings: [],
    artifacts: [],
    plan: {
      kind: "steps",
      steps: [{
        id: "single",
        label: "single",
        kind: "process",
        executable: "py",
        args: ["--version"],
      }],
    },
  };
  const commandText = "resolved-local-trigger-command";
  const commandHash = createHash("sha256").update(commandText, "utf8").digest("hex");
  const resolutionManifest = {
    ...baseManifest,
    expectedResolvedCommandSha256: commandHash,
  };
  const resolution = await resolveLocalActionTrigger({
    loaded: { ...loaded, manifest: resolutionManifest },
    config,
    resolveAction: async () => ({
      ...resolvedAction,
      command: commandText,
      displayCommand: commandText,
    }),
  });
  assert.equal(resolution.commandSha256, commandHash);
  assert.equal(resolution.resolved.profile, "python");

  const injectedExecution = await executeResolvedAction({
    resolved: {
      ...resolvedAction,
      preset: "execute",
      plan: {
        kind: "steps",
        steps: [{
          id: "credential",
          label: "credential",
          kind: "process",
          executable: process.execPath,
          args: [
            "-e",
            "process.exit(process.env.IW_AO_OPENAI_API_KEY === 'trigger-test-secret' ? 0 : 7)",
          ],
        }],
      },
    },
    workspaceRoot: projectRoot,
    triggerId: "credential-injection-test",
  }, async () => "trigger-test-secret");
  assert.equal(injectedExecution.exitCode, 0);
  assert.equal(injectedExecution.processStartedCount, 1);
  await assert.rejects(
    executeResolvedAction({
      resolved: { ...resolvedAction, preset: "execute" },
      workspaceRoot: projectRoot,
      triggerId: "credential-missing-test",
    }, async () => undefined),
    /credential is absent from the canonical SOPS store/,
  );

  const claim = await claimLocalActionTrigger(stateDir, "atomic-test", {
    manifestSha256: "c".repeat(64),
    fireAtUtc: baseManifest.fireAtUtc,
    evidencePath: baseManifest.evidencePath,
    nowUtc: "2026-08-06T00:00:00.000Z",
    pid: 123,
  });
  assert.equal(claim.claimed, true);
  const duplicate = await claimLocalActionTrigger(stateDir, "atomic-test", {
    manifestSha256: "c".repeat(64),
    fireAtUtc: baseManifest.fireAtUtc,
    evidencePath: baseManifest.evidencePath,
    nowUtc: "2026-08-06T00:00:00.001Z",
    pid: 124,
  });
  assert.equal(duplicate.claimed, false);

  let spawned:
    | { command: string; args: string[]; options: Record<string, unknown> }
    | undefined;
  const armed = await armLocalActionTrigger({
    currentCliPath: join(root, "dist", "cli.js"),
    manifestPath,
    expectedManifestSha256: canonical.sha256,
    config,
  }, {
    platform: "linux",
    spawnWorker: (command, args, options) => {
      spawned = { command, args: [...args], options: { ...options } };
      return { pid: 456, unref: () => undefined };
    },
    scheduleWindowsWorker: async () => {
      throw new Error("non-Windows arm must not use Task Scheduler");
    },
  });
  assert.equal(armed.pid, 456);
  assert.equal(armed.transport, "detached_worker");
  assert.equal(armed.machineRestartPersistence, false);
  assert.ok(spawned);
  assert.equal(spawned.command, process.execPath);
  assert.deepEqual(spawned.options, {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  assert.ok(spawned.args.includes("__local-action-trigger-worker"));
  assert.ok(spawned.args.includes(canonical.sha256));

  let scheduled:
    | {
        workerCommand: string;
        workerArgs: readonly string[];
        triggerId: string;
        fireAtUtc: string;
        expiresAtUtc: string;
        stateDir: string;
      }
    | undefined;
  const windowsArmed = await armLocalActionTrigger({
    currentCliPath: join(root, "dist", "cli.js"),
    manifestPath,
    expectedManifestSha256: canonical.sha256,
    config,
  }, {
    platform: "win32",
    spawnWorker: () => {
      throw new Error("Windows arm must not spawn a detached waiting worker");
    },
    scheduleWindowsWorker: async (input) => {
      scheduled = input;
      return {
        taskName: "Workbridge-LocalActionTrigger-d66-test-trigger",
        taskXmlPath: join(stateDir, "task.xml"),
        configSnapshotPath: join(stateDir, "config.json"),
        configSnapshotSha256: "b".repeat(64),
      };
    },
  });
  assert.ok(scheduled);
  assert.equal(scheduled.triggerId, baseManifest.triggerId);
  assert.equal(scheduled.fireAtUtc, baseManifest.fireAtUtc);
  assert.equal(scheduled.expiresAtUtc, baseManifest.expiresAtUtc);
  assert.equal(windowsArmed.transport, "windows_task_scheduler");
  assert.equal(windowsArmed.machineRestartPersistence, true);
  assert.equal(windowsArmed.taskName, "Workbridge-LocalActionTrigger-d66-test-trigger");
  assert.equal(windowsArmed.pid, undefined);

  let registeredTask: { taskName: string; taskXmlPath: string } | undefined;
  const scheduledTask = await scheduleWindowsLocalActionTrigger({
    stateDir,
    allowedRoots: config.allowedRoots,
    triggerId: "scheduler-xml-test",
    fireAtUtc: "2026-08-17T20:15:00.000Z",
    expiresAtUtc: "2026-08-17T20:30:00.000Z",
    workerCommand: "C:\\Program Files\\nodejs\\node.exe",
    workerArgs: [
      "C:\\Program Files\\Workbridge & Tools\\dist\\cli.js",
      "__local-action-trigger-worker",
      "--manifest",
      "C:\\state & data\\trigger.json",
      "--manifest-sha256",
      "a".repeat(64),
      "--launch-mode",
      "windows_task_scheduler",
    ],
  }, {
    currentUserId: async () => "TESTDOMAIN\\User & Test",
    registerTask: async (taskName, taskXmlPath) => {
      registeredTask = { taskName, taskXmlPath };
    },
  });
  assert.deepEqual(registeredTask, {
    taskName: scheduledTask.taskName,
    taskXmlPath: scheduledTask.taskXmlPath,
  });
  const taskXmlBytes = await readFile(scheduledTask.taskXmlPath);
  assert.deepEqual([...taskXmlBytes.subarray(0, 2)], [0xff, 0xfe]);
  const taskXml = taskXmlBytes.subarray(2).toString("utf16le");
  assert.match(taskXml, /<StartBoundary>2026-08-17T20:15:00\.000Z<\/StartBoundary>/);
  assert.match(taskXml, /<EndBoundary>2026-08-17T20:30:00\.000Z<\/EndBoundary>/);
  assert.match(taskXml, /<StartWhenAvailable>true<\/StartWhenAvailable>/);
  assert.match(taskXml, /<MultipleInstancesPolicy>IgnoreNew<\/MultipleInstancesPolicy>/);
  assert.match(taskXml, /<AllowStartOnDemand>false<\/AllowStartOnDemand>/);
  assert.match(taskXml, /<WakeToRun>true<\/WakeToRun>/);
  assert.match(taskXml, /TESTDOMAIN\\User &amp; Test/);
  assert.match(taskXml, /Workbridge &amp; Tools/);
  assert.match(taskXml, /--config-snapshot/);
  const snapshot = await loadWindowsLocalActionTriggerConfigSnapshot(
    scheduledTask.configSnapshotPath,
    scheduledTask.configSnapshotSha256,
  );
  assert.deepEqual(snapshot, config);
  await writeFile(scheduledTask.configSnapshotPath, "{}\n", "utf8");
  await assert.rejects(
    loadWindowsLocalActionTriggerConfigSnapshot(
      scheduledTask.configSnapshotPath,
      scheduledTask.configSnapshotSha256,
    ),
    /SHA-256 mismatch/,
  );
  assert.throws(
    () => parseLocalActionTriggerWorkerArgs([
      "--manifest", manifestPath,
      "--manifest-sha256", canonical.sha256,
      "--launch-mode", "windows_task_scheduler",
    ]),
    /requires a config snapshot/,
  );

  const workerManifest: LocalActionTriggerManifest = {
    ...baseManifest,
    triggerId: "worker-success",
    expectedResolvedCommandSha256: commandHash,
    evidencePath: join(evidenceDir, "worker-success.json"),
  };
  const workerCanonical = canonicalLocalActionTriggerManifest(workerManifest);
  const workerManifestPath = join(manifestDir, "worker-success.json");
  await writeFile(workerManifestPath, workerCanonical.bytes);
  let starts = 0;
  let workerNow = Date.parse("2026-08-06T00:00:00.000Z");
  const executeResult: LocalActionTriggerExecutionResult = {
    processStartedCount: 1,
    exitCode: 0,
    outputSha256: "d".repeat(64),
    stdoutSha256: "e".repeat(64),
    stderrSha256: "f".repeat(64),
    outputCharacters: 10,
    outputTruncated: false,
    steps: [],
  };
  const workerResult = await runLocalActionTriggerWorker({
    manifestPath: workerManifestPath,
    expectedManifestSha256: workerCanonical.sha256,
    config,
  }, {
    now: () => new Date(workerNow),
    sleep: async (milliseconds) => {
      workerNow += milliseconds;
    },
    resolveAction: async () => ({
      ...resolvedAction,
      command: commandText,
      displayCommand: commandText,
    }),
    executeAction: async () => {
      starts += 1;
      return executeResult;
    },
  });
  assert.equal(starts, 1);
  assert.equal(workerResult.status, "completed");
  assert.equal(workerResult.processStartedCount, 1);
  const writtenEvidence = JSON.parse(await readFile(workerManifest.evidencePath, "utf8")) as {
    status: string;
    processStartedCount: number;
  };
  assert.equal(writtenEvidence.status, "completed");
  assert.equal(writtenEvidence.processStartedCount, 1);

  const multiStepManifest: LocalActionTriggerManifest = {
    ...baseManifest,
    triggerId: "worker-multi-step-success",
    expectedResolvedCommandSha256: commandHash,
    evidencePath: join(evidenceDir, "worker-multi-step-success.json"),
  };
  const multiStepCanonical = canonicalLocalActionTriggerManifest(multiStepManifest);
  const multiStepManifestPath = join(manifestDir, "worker-multi-step-success.json");
  await writeFile(multiStepManifestPath, multiStepCanonical.bytes);
  const multiStepResult = await runLocalActionTriggerWorker({
    manifestPath: multiStepManifestPath,
    expectedManifestSha256: multiStepCanonical.sha256,
    config,
  }, {
    now: () => new Date("2026-08-06T00:00:05.000Z"),
    sleep: async () => undefined,
    resolveAction: async () => ({
      ...resolvedAction,
      command: commandText,
      displayCommand: commandText,
      plan: {
        kind: "steps",
        steps: [
          { id: "first", label: "first", kind: "process", executable: "py", args: ["--version"] },
          { id: "second", label: "second", kind: "process", executable: "py", args: ["--version"] },
        ],
      },
    }),
    executeAction: async () => ({
      ...executeResult,
      processStartedCount: 2,
      steps: [
        { id: "first", label: "first", status: "completed", exitCode: 0, durationMs: 10 },
        { id: "second", label: "second", status: "completed", exitCode: 0, durationMs: 20 },
      ],
    }),
  });
  assert.equal(multiStepResult.status, "completed");
  assert.equal(multiStepResult.processStartedCount, 2);

  const unexpectedStartManifest: LocalActionTriggerManifest = {
    ...baseManifest,
    triggerId: "worker-unexpected-extra-start",
    expectedResolvedCommandSha256: commandHash,
    evidencePath: join(evidenceDir, "worker-unexpected-extra-start.json"),
  };
  const unexpectedStartCanonical = canonicalLocalActionTriggerManifest(unexpectedStartManifest);
  const unexpectedStartPath = join(manifestDir, "worker-unexpected-extra-start.json");
  await writeFile(unexpectedStartPath, unexpectedStartCanonical.bytes);
  const unexpectedStartResult = await runLocalActionTriggerWorker({
    manifestPath: unexpectedStartPath,
    expectedManifestSha256: unexpectedStartCanonical.sha256,
    config,
  }, {
    now: () => new Date("2026-08-06T00:00:05.000Z"),
    sleep: async () => undefined,
    resolveAction: async () => ({
      ...resolvedAction,
      command: commandText,
      displayCommand: commandText,
    }),
    executeAction: async () => ({ ...executeResult, processStartedCount: 2 }),
  });
  assert.equal(unexpectedStartResult.status, "failed");

  const scheduledWorkerManifest: LocalActionTriggerManifest = {
    ...baseManifest,
    triggerId: "worker-scheduled-success",
    expectedResolvedCommandSha256: commandHash,
    evidencePath: join(evidenceDir, "worker-scheduled-success.json"),
  };
  const scheduledWorkerCanonical = canonicalLocalActionTriggerManifest(scheduledWorkerManifest);
  const scheduledWorkerManifestPath = join(manifestDir, "worker-scheduled-success.json");
  await writeFile(scheduledWorkerManifestPath, scheduledWorkerCanonical.bytes);
  const scheduledWorkerResult = await runLocalActionTriggerWorker({
    manifestPath: scheduledWorkerManifestPath,
    expectedManifestSha256: scheduledWorkerCanonical.sha256,
    config,
    launchMode: "windows_task_scheduler",
  }, {
    now: () => new Date("2026-08-06T00:00:05.000Z"),
    sleep: async () => undefined,
    resolveAction: async () => ({
      ...resolvedAction,
      command: commandText,
      displayCommand: commandText,
    }),
    executeAction: async () => executeResult,
  });
  assert.equal(scheduledWorkerResult.status, "completed");
  assert.equal(scheduledWorkerResult.hostIndependence.machineRestartPersistence, true);
  assert.equal(scheduledWorkerResult.hostIndependence.detachedWorker, false);

  const expiredManifest: LocalActionTriggerManifest = {
    ...baseManifest,
    triggerId: "worker-expired",
    expectedResolvedCommandSha256: commandHash,
    fireAtUtc: "2026-08-06T00:00:00.000Z",
    expiresAtUtc: "2026-08-06T00:00:01.000Z",
    evidencePath: join(evidenceDir, "worker-expired.json"),
  };
  const expiredCanonical = canonicalLocalActionTriggerManifest(expiredManifest);
  const expiredPath = join(manifestDir, "worker-expired.json");
  await writeFile(expiredPath, expiredCanonical.bytes);
  const expiredResult = await runLocalActionTriggerWorker({
    manifestPath: expiredPath,
    expectedManifestSha256: expiredCanonical.sha256,
    config,
  }, {
    now: () => new Date("2026-08-06T00:00:02.000Z"),
    sleep: async () => undefined,
    resolveAction: async () => {
      throw new Error("expired trigger must not resolve an action");
    },
    executeAction: async () => {
      throw new Error("expired trigger must not execute");
    },
  });
  assert.equal(expiredResult.status, "expired");

  const failureManifest: LocalActionTriggerManifest = {
    ...baseManifest,
    triggerId: "worker-failure",
    expectedResolvedCommandSha256: commandHash,
    evidencePath: join(evidenceDir, "worker-failure.json"),
  };
  const failureCanonical = canonicalLocalActionTriggerManifest(failureManifest);
  const failurePath = join(manifestDir, "worker-failure.json");
  await writeFile(failurePath, failureCanonical.bytes);
  const failureResult = await runLocalActionTriggerWorker({
    manifestPath: failurePath,
    expectedManifestSha256: failureCanonical.sha256,
    config,
  }, {
    now: () => new Date("2026-08-06T00:00:05.000Z"),
    sleep: async () => undefined,
    resolveAction: async () => ({
      ...resolvedAction,
      command: commandText,
      displayCommand: commandText,
    }),
    executeAction: async () => ({
      ...executeResult,
      exitCode: 1,
    }),
  });
  assert.equal(failureResult.status, "failed");
  assert.equal(failureResult.processStartedCount, 1);
  assert.match(await readFile(failureResult.claimPath, "utf8"), /worker-failure/);

  const mismatchManifest: LocalActionTriggerManifest = {
    ...baseManifest,
    triggerId: "worker-manifest-mismatch",
    expectedResolvedCommandSha256: commandHash,
    evidencePath: join(evidenceDir, "worker-manifest-mismatch.json"),
  };
  const mismatchCanonical = canonicalLocalActionTriggerManifest(mismatchManifest);
  const mismatchPath = join(manifestDir, "worker-manifest-mismatch.json");
  await writeFile(mismatchPath, mismatchCanonical.bytes);
  let mismatchNow = Date.parse("2026-08-06T00:00:00.000Z");
  const mismatchResult = await runLocalActionTriggerWorker({
    manifestPath: mismatchPath,
    expectedManifestSha256: mismatchCanonical.sha256,
    config,
  }, {
    now: () => new Date(mismatchNow),
    sleep: async (milliseconds) => {
      mismatchNow += milliseconds;
      await writeFile(mismatchPath, "{}\n", "utf8");
    },
    resolveAction: async () => {
      throw new Error("modified manifest must not resolve an action");
    },
    executeAction: async () => {
      throw new Error("modified manifest must not execute");
    },
  });
  assert.equal(mismatchResult.status, "manifest_mismatch");
  assert.equal(mismatchResult.processStartedCount, 0);
} finally {
  await rm(root, { recursive: true, force: true });
}

console.log("local action trigger tests passed");
