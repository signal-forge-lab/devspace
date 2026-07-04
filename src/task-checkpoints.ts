import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface TaskCheckpointInput {
  workspaceId: string;
  root: string;
  title: string;
  objective: string;
  completed?: string[];
  pending?: string[];
  changedFiles?: string[];
  validation?: string[];
  filteredOperations?: string[];
  blockedOperations?: string[];
  nextAction?: string;
  notes?: string;
}

export interface TaskCheckpointRecord extends Record<string, unknown> {
  checkpointId: string;
  workspaceId: string;
  createdAt: string;
  title: string;
  objective: string;
  completed: string[];
  pending: string[];
  changedFiles: string[];
  validation: string[];
  filteredOperations: string[];
  nextAction?: string;
  notes?: string;
}

export interface TaskCheckpointResult extends Record<string, unknown> {
  checkpointId: string;
  path: string;
  record: TaskCheckpointRecord;
  result: string;
}

export interface TaskResumeResult extends Record<string, unknown> {
  checkpointId?: string;
  path?: string;
  record?: TaskCheckpointRecord;
  result: string;
}

export async function saveTaskCheckpoint(input: TaskCheckpointInput, now: () => Date = () => new Date()): Promise<TaskCheckpointResult> {
  const createdAt = now().toISOString();
  const checkpointId = buildCheckpointId(createdAt, input.title);
  const dir = checkpointDirectory(input.root);
  await mkdir(dir, { recursive: true });
  const path = join(dir, `${checkpointId}.json`);
  const record: TaskCheckpointRecord = {
    checkpointId,
    workspaceId: input.workspaceId,
    createdAt,
    title: input.title,
    objective: input.objective,
    completed: input.completed ?? [],
    pending: input.pending ?? [],
    changedFiles: input.changedFiles ?? [],
    validation: input.validation ?? [],
    filteredOperations: input.filteredOperations ?? input.blockedOperations ?? [],
    nextAction: input.nextAction,
    notes: input.notes,
  };
  await writeFile(path, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  return {
    checkpointId,
    path,
    record,
    result: `Saved task checkpoint ${checkpointId}.`,
  };
}

export async function resumeTaskCheckpoint(input: {
  root: string;
  checkpointId?: string;
}): Promise<TaskResumeResult> {
  const dir = checkpointDirectory(input.root);
  let checkpointId = input.checkpointId;
  if (!checkpointId) checkpointId = await latestCheckpointId(dir);
  if (!checkpointId) return { result: "No task checkpoints found." };
  const path = join(dir, checkpointId.endsWith(".json") ? checkpointId : `${checkpointId}.json`);
  const record = JSON.parse(await readFile(path, "utf8")) as TaskCheckpointRecord;
  return {
    checkpointId: record.checkpointId,
    path,
    record,
    result: formatResumeResult(record),
  };
}

function checkpointDirectory(root: string): string {
  return join(root, ".devspace", "task-checkpoints");
}

async function latestCheckpointId(dir: string): Promise<string | undefined> {
  let files: string[];
  try {
    files = await readdir(dir);
  } catch {
    return undefined;
  }
  return files.filter((file) => file.endsWith(".json")).sort().at(-1);
}

function buildCheckpointId(createdAt: string, title: string): string {
  const timestamp = createdAt.replace(/[-:.TZ]/g, "").slice(0, 14);
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "task";
  return `${timestamp}_${slug}`;
}

function formatResumeResult(record: TaskCheckpointRecord): string {
  return [
    `Checkpoint: ${record.checkpointId}`,
    `Title: ${record.title}`,
    `Objective: ${record.objective}`,
    record.completed.length ? `Completed: ${record.completed.join("; ")}` : undefined,
    record.pending.length ? `Pending: ${record.pending.join("; ")}` : undefined,
    record.changedFiles.length ? `Changed files: ${record.changedFiles.join(", ")}` : undefined,
    record.validation.length ? `Validation: ${record.validation.join("; ")}` : undefined,
    record.filteredOperations.length ? `Filtered attempts: ${record.filteredOperations.join("; ")}` : undefined,
    record.nextAction ? `Next action: ${record.nextAction}` : undefined,
    record.notes ? `Notes: ${record.notes}` : undefined,
  ].filter(Boolean).join("\n");
}
