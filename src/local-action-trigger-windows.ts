import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";

const CONFIG_SNAPSHOT_SCHEMA_VERSION = "workbridge_local_action_trigger_config_v1";
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

export interface WindowsLocalActionTriggerScheduleInput {
  stateDir: string;
  allowedRoots: readonly string[];
  triggerId: string;
  fireAtUtc: string;
  expiresAtUtc: string;
  workerCommand: string;
  workerArgs: readonly string[];
}

export interface WindowsTaskSchedulerRuntime {
  currentUserId(): Promise<string>;
  registerTask(taskName: string, taskXmlPath: string): Promise<void>;
}

export async function scheduleWindowsLocalActionTrigger(
  input: WindowsLocalActionTriggerScheduleInput,
  runtime: WindowsTaskSchedulerRuntime = defaultRuntime,
): Promise<{
  taskName: string;
  taskXmlPath: string;
  configSnapshotPath: string;
  configSnapshotSha256: string;
}> {
  const taskName = `Workbridge-LocalActionTrigger-${input.triggerId}`;
  const triggerRoot = resolve(input.stateDir, "local-action-triggers");
  const taskRoot = join(triggerRoot, "tasks");
  const configRoot = join(triggerRoot, "configs");
  await mkdir(taskRoot, { recursive: true });
  await mkdir(configRoot, { recursive: true });
  const taskXmlPath = join(taskRoot, `${input.triggerId}.xml`);
  const configSnapshotPath = join(configRoot, `${input.triggerId}.json`);
  const configSnapshot = {
    schemaVersion: CONFIG_SNAPSHOT_SCHEMA_VERSION,
    stateDir: resolve(input.stateDir),
    allowedRoots: input.allowedRoots.map((root) => resolve(root)),
  };
  const configBytes = canonicalConfigSnapshotBytes(configSnapshot);
  const configSnapshotSha256 = sha256Bytes(configBytes);
  await writeFile(configSnapshotPath, configBytes, { flag: "wx" });
  const userId = (await runtime.currentUserId()).trim();
  if (!userId) throw new Error("Windows Task Scheduler user identity is empty.");
  const workerArgs = [
    ...input.workerArgs,
    "--config-snapshot", configSnapshotPath,
    "--config-snapshot-sha256", configSnapshotSha256,
  ];
  await writeFile(taskXmlPath, encodeTaskXml(buildTaskXml({ ...input, workerArgs }, userId)), { flag: "wx" });
  await runtime.registerTask(taskName, taskXmlPath);
  return { taskName, taskXmlPath, configSnapshotPath, configSnapshotSha256 };
}

export async function loadWindowsLocalActionTriggerConfigSnapshot(
  snapshotPath: string,
  expectedSha256: string,
): Promise<{ allowedRoots: string[]; stateDir: string }> {
  if (!SHA256_PATTERN.test(expectedSha256)) {
    throw new Error("Windows local action trigger config snapshot SHA-256 is invalid.");
  }
  const bytes = await readFile(snapshotPath);
  if (sha256Bytes(bytes) !== expectedSha256) {
    throw new Error("Windows local action trigger config snapshot SHA-256 mismatch.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error("Windows local action trigger config snapshot is not valid JSON.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Windows local action trigger config snapshot must be an object.");
  }
  const record = parsed as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (keys.join(",") !== "allowedRoots,schemaVersion,stateDir") {
    throw new Error("Windows local action trigger config snapshot keys mismatch.");
  }
  if (record.schemaVersion !== CONFIG_SNAPSHOT_SCHEMA_VERSION) {
    throw new Error("Windows local action trigger config snapshot schema is not supported.");
  }
  if (typeof record.stateDir !== "string" || !isAbsolute(record.stateDir)) {
    throw new Error("Windows local action trigger config snapshot stateDir must be absolute.");
  }
  if (!Array.isArray(record.allowedRoots) || record.allowedRoots.length === 0 ||
      record.allowedRoots.some((root) => typeof root !== "string" || !isAbsolute(root))) {
    throw new Error("Windows local action trigger config snapshot allowedRoots are invalid.");
  }
  const snapshot = {
    schemaVersion: CONFIG_SNAPSHOT_SCHEMA_VERSION,
    stateDir: resolve(record.stateDir),
    allowedRoots: record.allowedRoots.map((root) => resolve(root as string)),
  };
  if (!bytes.equals(canonicalConfigSnapshotBytes(snapshot))) {
    throw new Error("Windows local action trigger config snapshot must use canonical JSON bytes.");
  }
  const configRoot = resolve(snapshot.stateDir, "local-action-triggers", "configs");
  const relativePath = relative(configRoot, resolve(snapshotPath));
  if (!relativePath || relativePath.startsWith("..") || isAbsolute(relativePath)) {
    throw new Error("Windows local action trigger config snapshot path is outside its state directory.");
  }
  return { allowedRoots: snapshot.allowedRoots, stateDir: snapshot.stateDir };
}

function buildTaskXml(input: WindowsLocalActionTriggerScheduleInput, userId: string): string {
  const argumentsText = input.workerArgs.map(quoteWindowsArgument).join(" ");
  return [
    '<?xml version="1.0" encoding="UTF-16"?>',
    '<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">',
    "  <RegistrationInfo>",
    "    <Description>Workbridge local action trigger</Description>",
    "  </RegistrationInfo>",
    "  <Triggers>",
    "    <TimeTrigger>",
    `      <StartBoundary>${escapeXml(input.fireAtUtc)}</StartBoundary>`,
    `      <EndBoundary>${escapeXml(input.expiresAtUtc)}</EndBoundary>`,
    "      <Enabled>true</Enabled>",
    "    </TimeTrigger>",
    "  </Triggers>",
    "  <Principals>",
    '    <Principal id="Author">',
    `      <UserId>${escapeXml(userId)}</UserId>`,
    "      <LogonType>InteractiveToken</LogonType>",
    "      <RunLevel>LeastPrivilege</RunLevel>",
    "    </Principal>",
    "  </Principals>",
    "  <Settings>",
    "    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>",
    "    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>",
    "    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>",
    "    <AllowHardTerminate>true</AllowHardTerminate>",
    "    <StartWhenAvailable>true</StartWhenAvailable>",
    "    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>",
    "    <AllowStartOnDemand>false</AllowStartOnDemand>",
    "    <Enabled>true</Enabled>",
    "    <Hidden>false</Hidden>",
    "    <RunOnlyIfIdle>false</RunOnlyIfIdle>",
    "    <WakeToRun>true</WakeToRun>",
    "    <ExecutionTimeLimit>PT24H</ExecutionTimeLimit>",
    "    <DeleteExpiredTaskAfter>PT1H</DeleteExpiredTaskAfter>",
    "    <Priority>7</Priority>",
    "  </Settings>",
    '  <Actions Context="Author">',
    "    <Exec>",
    `      <Command>${escapeXml(input.workerCommand)}</Command>`,
    `      <Arguments>${escapeXml(argumentsText)}</Arguments>`,
    "    </Exec>",
    "  </Actions>",
    "</Task>",
    "",
  ].join("\r\n");
}

function quoteWindowsArgument(value: string): string {
  if (value.length === 0) return '""';
  if (!/[\t "]/u.test(value)) return value;
  let result = '"';
  let backslashes = 0;
  for (const character of value) {
    if (character === "\\") {
      backslashes += 1;
      continue;
    }
    if (character === '"') {
      result += "\\".repeat(backslashes * 2 + 1) + '"';
      backslashes = 0;
      continue;
    }
    result += "\\".repeat(backslashes) + character;
    backslashes = 0;
  }
  return result + "\\".repeat(backslashes * 2) + '"';
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function canonicalConfigSnapshotBytes(value: object): Buffer {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function encodeTaskXml(value: string): Buffer {
  return Buffer.concat([
    Buffer.from([0xff, 0xfe]),
    Buffer.from(value, "utf16le"),
  ]);
}

function sha256Bytes(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

const defaultRuntime: WindowsTaskSchedulerRuntime = {
  currentUserId: async () => await execFileText("whoami.exe", []),
  registerTask: async (taskName, taskXmlPath) => {
    await execFileText("schtasks.exe", ["/Create", "/TN", taskName, "/XML", taskXmlPath]);
  },
};

async function execFileText(command: string, args: readonly string[]): Promise<string> {
  return await new Promise<string>((resolvePromise, rejectPromise) => {
    execFile(command, [...args], { encoding: "utf8", windowsHide: true }, (error, stdout, stderr) => {
      if (error) {
        rejectPromise(new Error(`${command} failed: ${stderr.trim() || error.message}`));
        return;
      }
      resolvePromise(stdout);
    });
  });
}
