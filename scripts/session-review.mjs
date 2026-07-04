#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);

function readArg(name, fallback = undefined) {
  const prefix = `--${name}=`;
  const inline = args.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = args.indexOf(`--${name}`);
  if (index >= 0 && index + 1 < args.length) return args[index + 1];
  return fallback;
}

function hasFlag(name) {
  return args.includes(`--${name}`);
}

function printHelp() {
  console.log(`Workbridge session review

Append one session-level review event to .devspace/session-reviews/events.jsonl.

Usage:
  node scripts/session-review.mjs --task "Workbridge cleanup" --size M --result partial --duration-minutes 65 --delay wrong_direction --summary "Renamed surface and updated memos"

Required:
  --task <text>
  --size S|M|L|XL
  --result done|partial|blocked|failed
`);
}

if (hasFlag("help") || hasFlag("h")) {
  printHelp();
  process.exit(0);
}

const allowedSizes = new Set(["S", "M", "L", "XL"]);
const allowedResults = new Set(["done", "partial", "blocked", "failed"]);
const allowedEfficiency = new Set(["good", "normal", "bad", "unknown"]);
const allowedDelay = new Set([
  "none",
  "tool_error",
  "connection_error",
  "schema_discovery",
  "large_output",
  "wrong_direction",
  "user_correction",
  "test_failure",
  "other",
]);

const task = readArg("task");
const workSize = readArg("size");
const result = readArg("result");
const delay = readArg("delay", "none");
const efficiency = readArg("efficiency", "unknown");
const summary = readArg("summary", "");
const nextAction = readArg("next", "");
const notes = readArg("notes", "");
const durationRaw = readArg("duration-minutes");
const startedAtRaw = readArg("started-at");
const endedAtRaw = readArg("ended-at");

const errors = [];

if (!task) errors.push("--task is required");
if (!workSize || !allowedSizes.has(workSize)) errors.push("--size must be one of S, M, L, XL");
if (!result || !allowedResults.has(result)) errors.push("--result must be one of done, partial, blocked, failed");
if (!allowedDelay.has(delay)) errors.push(`--delay must be one of ${Array.from(allowedDelay).join(", ")}`);
if (!allowedEfficiency.has(efficiency)) errors.push("--efficiency must be one of good, normal, bad, unknown");

let durationMinutes = durationRaw === undefined ? undefined : Number(durationRaw);
if (durationRaw !== undefined && (!Number.isFinite(durationMinutes) || durationMinutes < 0)) {
  errors.push("--duration-minutes must be a non-negative number");
}

function parseDate(value, name) {
  if (!value) return undefined;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    errors.push(`${name} must be a valid date/time`);
    return undefined;
  }
  return date;
}

const endedAtDate = parseDate(endedAtRaw, "--ended-at") ?? new Date();
let startedAtDate = parseDate(startedAtRaw, "--started-at");

if (!startedAtDate && durationMinutes !== undefined) {
  startedAtDate = new Date(endedAtDate.getTime() - durationMinutes * 60_000);
}

if (startedAtDate && durationMinutes === undefined) {
  durationMinutes = Math.max(0, Math.round((endedAtDate.getTime() - startedAtDate.getTime()) / 60_000));
}

if (startedAtDate && startedAtDate.getTime() > endedAtDate.getTime()) {
  errors.push("--started-at must be before --ended-at");
}

if (errors.length > 0) {
  console.error(`session-review: invalid arguments\n- ${errors.join("\n- ")}\n`);
  printHelp();
  process.exit(2);
}

const reviewPath = readArg(
  "path",
  process.env.WORKBRIDGE_SESSION_REVIEW_PATH ?? ".devspace/session-reviews/events.jsonl",
);

const event = {
  schemaVersion: 1,
  sessionId: readArg("session-id", `session_${endedAtDate.toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}`),
  task,
  workSize,
  result,
  efficiency,
  mainDelayReason: delay,
  startedAt: startedAtDate?.toISOString(),
  endedAt: endedAtDate.toISOString(),
  durationMinutes,
  completedSummary: summary,
  nextAction,
  notes,
};

if (hasFlag("dry-run")) {
  console.log(JSON.stringify(event, null, 2));
  process.exit(0);
}

fs.mkdirSync(path.dirname(reviewPath), { recursive: true });
fs.appendFileSync(reviewPath, `${JSON.stringify(event)}\n`, "utf8");

console.log(`session-review: appended ${reviewPath}`);
console.log(`- sessionId: ${event.sessionId}`);
console.log(`- task: ${event.task}`);
console.log(`- size/result: ${event.workSize}/${event.result}`);
if (event.durationMinutes !== undefined) console.log(`- durationMinutes: ${event.durationMinutes}`);
console.log(`- delay: ${event.mainDelayReason}`);
