#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

const DEFAULT_TIMEOUT_MS = 120_000;

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }

  const packageJson = JSON.parse(readFileSync("package.json", "utf8"));
  const checks = [];
  const manualMcpChecks = buildManualMcpChecks();

  checks.push(runCheck("git_status_short", "git", ["status", "--short"], { timeoutMs: 30_000, expectEmptyStdout: false }));
  checks.push(runCheck("git_diff_check", "git", ["diff", "--check"], { timeoutMs: 30_000, expectEmptyStdout: true }));

  if (!options.quick) {
    checks.push(runCheck("typecheck", npmBin(), ["run", "typecheck"], { timeoutMs: DEFAULT_TIMEOUT_MS }));
    if (existsSync(".devspace/workflow-events")) {
      checks.push(runCheck("workflow_log_analysis_json", "node", ["scripts/analyze-devspace-logs.mjs", ".devspace/workflow-events", "--json"], { timeoutMs: DEFAULT_TIMEOUT_MS, validateJson: true }));
    }
  }

  if (options.build) checks.push(runCheck("build", npmBin(), ["run", "build"], { timeoutMs: 300_000 }));

  const report = {
    generatedAt: new Date().toISOString(),
    package: {
      name: packageJson.name,
      version: packageJson.version,
    },
    cwd: resolve("."),
    mode: options.quick ? "quick" : options.build ? "build" : "full",
    localChecks: checks,
    manualMcpChecks,
    summary: {
      localChecks: checks.length,
      localFailures: checks.filter((check) => check.status !== "ok").length,
      manualChecks: manualMcpChecks.length,
    },
  };

  if (options.json) console.log(JSON.stringify(report, null, 2));
  else console.log(formatText(report));

  if (report.summary.localFailures > 0) process.exitCode = 1;
}

function parseArgs(args) {
  const options = { json: false, quick: false, build: false, help: false };
  for (const arg of args) {
    if (arg === "--json") options.json = true;
    else if (arg === "--quick") options.quick = true;
    else if (arg === "--build") options.build = true;
    else if (arg === "--help" || arg === "-h") options.help = true;
    else throw new Error(`Unknown option: ${arg}`);
  }
  return options;
}

function npmBin() {
  return process.platform === "win32" ? "npm" : "npm";
}

function runCheck(name, bin, args, options = {}) {
  const startedAt = Date.now();
  const result = spawnSync(bin, args, {
    shell: process.platform === "win32" && (bin === "npm" || bin === "npx"),
    encoding: "utf8",
    windowsHide: true,
    timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    maxBuffer: 1024 * 1024,
  });
  const durationMs = Date.now() - startedAt;
  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  const timedOut = result.error?.code === "ETIMEDOUT" || result.signal === "SIGTERM";
  let status = timedOut ? "timed_out" : result.status === 0 ? "ok" : "failed";
  const notes = [];

  if (status === "ok" && options.expectEmptyStdout && stdout.trim().length > 0) {
    status = "failed";
    notes.push("Expected empty stdout.");
  }

  if (status === "ok" && options.validateJson) {
    try {
      JSON.parse(stdout);
    } catch (error) {
      status = "failed";
      notes.push(`JSON validation failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (result.error && !timedOut) notes.push(result.error.message);

  return {
    name,
    command: [bin, ...args].join(" "),
    status,
    exitCode: result.status ?? undefined,
    signal: result.signal ?? undefined,
    durationMs,
    stdoutChars: stdout.length,
    stderrChars: stderr.length,
    stdoutTail: stdout ? tail(stdout, 600) : undefined,
    stderrTail: stderr ? tail(stderr, 600) : undefined,
    notes,
  };
}

function buildManualMcpChecks() {
  return [
    {
      id: "tool_visible",
      action: "Confirm `devspace_verify` is visible in ChatGPT after DevSpace restart.",
      expected: "Tool schema lists all fixed profiles, including build and git_status_check.",
    },
    {
      id: "git_status_check",
      action: "Run `devspace_verify` with profile `git_status_check` and workflowMode `router`.",
      expected: "status=ok, no schema validation error, stdoutOmitted=false.",
    },
    {
      id: "git_diff_check",
      action: "Run `devspace_verify` with profile `git_diff_check`.",
      expected: "status=ok and no `git diff --check` output.",
    },
    {
      id: "build_profile",
      action: "Run `devspace_verify` with profile `build`.",
      expected: "status=ok, stdoutOmitted=true, only bounded stderrTail for known chunk-size warning if present.",
    },
    {
      id: "workflow_event",
      action: "Run at least one verify profile with workflowMode `router`.",
      expected: "`.devspace/workflow-events/events.jsonl` receives a devspace_verify event.",
    },
    {
      id: "log_report",
      action: "Run `npm run logs:report` or `node scripts/analyze-devspace-logs.mjs logs .devspace/workflow-events --html reports/devspace-log-analysis.html`.",
      expected: "HTML report contains Verify Profiles and Workflow Events sections.",
    },
  ];
}

function formatText(report) {
  const lines = [];
  lines.push("DevSpace Startup Smoke");
  lines.push("======================");
  lines.push(`Generated: ${report.generatedAt}`);
  lines.push(`Package: ${report.package.name}@${report.package.version}`);
  lines.push(`Mode: ${report.mode}`);
  lines.push(`CWD: ${report.cwd}`);
  lines.push("");
  lines.push("Local checks");
  for (const check of report.localChecks) {
    lines.push(`- ${check.name}: ${check.status} (${check.durationMs}ms, stdout=${check.stdoutChars}, stderr=${check.stderrChars})`);
    for (const note of check.notes) lines.push(`  note: ${note}`);
  }
  lines.push("");
  lines.push("Manual MCP checks after restart");
  for (const check of report.manualMcpChecks) lines.push(`- ${check.id}: ${check.action} Expected: ${check.expected}`);
  lines.push("");
  lines.push(`Summary: ${report.summary.localChecks} local check(s), ${report.summary.localFailures} local failure(s), ${report.summary.manualChecks} manual MCP check(s).`);
  return lines.join("\n");
}

function tail(value, maxChars) {
  return value.length <= maxChars ? value : value.slice(value.length - maxChars);
}

function printHelp() {
  console.log(`DevSpace startup smoke checker

Usage:
  node scripts/smoke-devspace-runtime.mjs [options]

Options:
      --quick   Run only quick local checks.
      --build   Include npm run build.
      --json    Print JSON report.
  -h, --help    Show this help.

Notes:
  This script cannot call ChatGPT MCP tools by itself. It prints the manual MCP
  checks that should be run after restarting DevSpace.
`);
}

main();
