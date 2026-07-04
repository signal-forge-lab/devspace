#!/usr/bin/env node
import { readFile, stat, mkdir, writeFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";

const DEFAULT_TOP_N = 12;
const LOG_EXTENSIONS = new Set([".jsonl", ".log", ".txt"]);

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }

  const inputPaths = options.inputs.length > 0 ? options.inputs : defaultInputPaths();
  const files = await collectLogFiles(inputPaths);
  const loaded = await loadLogEntries(files, options);
  const report = buildReport(loaded.entries, loaded, options);

  if (options.json) console.log(JSON.stringify(report, null, 2));
  else console.log(formatTextReport(report));

  if (options.htmlPath) {
    const outputPath = resolve(options.htmlPath);
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, renderHtmlReport(report), "utf8");
    console.error(`Wrote HTML report: ${outputPath}`);
  }
}

function parseArgs(args) {
  const options = {
    inputs: [],
    htmlPath: undefined,
    json: false,
    since: undefined,
    until: undefined,
    appVersion: undefined,
    gitCommit: undefined,
    top: DEFAULT_TOP_N,
    bucket: "auto",
    help: false,
  };

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--input" || arg === "-i") options.inputs.push(requireValue(args, ++i, arg));
    else if (arg === "--html") options.htmlPath = requireValue(args, ++i, arg);
    else if (arg === "--json") options.json = true;
    else if (arg === "--since") options.since = parseDateOption(requireValue(args, ++i, arg), arg);
    else if (arg === "--until") options.until = parseDateOption(requireValue(args, ++i, arg), arg);
    else if (arg === "--version") options.appVersion = requireValue(args, ++i, arg);
    else if (arg === "--commit") options.gitCommit = requireValue(args, ++i, arg);
    else if (arg === "--top") options.top = parsePositiveInteger(requireValue(args, ++i, arg), arg);
    else if (arg === "--bucket") {
      const value = requireValue(args, ++i, arg);
      if (!["auto", "minute", "hour", "day"].includes(value)) throw new Error(`Invalid --bucket value: ${value}`);
      options.bucket = value;
    } else if (arg.startsWith("-")) throw new Error(`Unknown option: ${arg}`);
    else options.inputs.push(arg);
  }

  return options;
}

function defaultInputPaths() {
  const paths = [];
  if (existsSync("logs")) paths.push("logs");
  if (existsSync(".devspace/workflow-events")) paths.push(".devspace/workflow-events");
  return paths.length > 0 ? paths : ["."];
}

function requireValue(args, index, optionName) {
  const value = args[index];
  if (!value || value.startsWith("--")) throw new Error(`${optionName} requires a value.`);
  return value;
}

function parseDateOption(value, optionName) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`Invalid ${optionName} date: ${value}`);
  return date;
}

function parsePositiveInteger(value, optionName) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`${optionName} must be a positive integer.`);
  return parsed;
}

async function collectLogFiles(paths) {
  const files = [];
  for (const inputPath of paths) await collectLogFilesFromPath(resolve(inputPath), files);
  return Array.from(new Set(files)).sort((a, b) => a.localeCompare(b));
}

async function collectLogFilesFromPath(path, files) {
  let stats;
  try {
    stats = await stat(path);
  } catch {
    return;
  }

  if (stats.isFile()) {
    if (LOG_EXTENSIONS.has(extname(path).toLowerCase())) files.push(path);
    return;
  }

  if (!stats.isDirectory()) return;
  const entries = await readdir(path, { withFileTypes: true });
  for (const entry of entries) {
    const childPath = join(path, entry.name);
    if (entry.isDirectory()) await collectLogFilesFromPath(childPath, files);
    else if (entry.isFile() && LOG_EXTENSIONS.has(extname(entry.name).toLowerCase())) files.push(childPath);
  }
}

async function loadLogEntries(files, options) {
  const entries = [];
  const errors = [];
  let lines = 0;
  let emptyLines = 0;
  let skippedTextLines = 0;

  for (const file of files) {
    const text = await readFile(file, "utf8");
    const fileLines = text.split(/\r?\n/);
    for (let index = 0; index < fileLines.length; index += 1) {
      const rawLine = fileLines[index].trim();
      if (!rawLine) {
        emptyLines += 1;
        continue;
      }
      lines += 1;
      if (!rawLine.startsWith("{")) {
        skippedTextLines += 1;
        continue;
      }
      try {
        const entry = JSON.parse(rawLine);
        const ts = parseEntryDate(entry);
        if (ts && options.since && ts < options.since) continue;
        if (ts && options.until && ts > options.until) continue;
        if (options.appVersion && entry.appVersion !== options.appVersion) continue;
        if (options.gitCommit && entry.gitCommit !== options.gitCommit) continue;
        entries.push({ ...entry, __file: file, __line: index + 1, __ts: ts?.toISOString() });
      } catch (error) {
        errors.push({ file, line: index + 1, message: errorMessage(error) });
      }
    }
  }

  return { files, entries, errors, lines, emptyLines, skippedTextLines };
}

function parseEntryDate(entry) {
  if (!entry) return undefined;
  const timestamp = typeof entry.ts === "string" ? entry.ts : typeof entry.createdAt === "string" ? entry.createdAt : undefined;
  if (!timestamp) return undefined;
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

function buildReport(entries, loaded, options) {
  const timestamps = entries
    .map((entry) => (entry.__ts ? new Date(entry.__ts) : undefined))
    .filter(Boolean)
    .sort((a, b) => a - b);
  const start = timestamps[0]?.toISOString();
  const end = timestamps.at(-1)?.toISOString();
  const eventCounts = countBy(entries, (entry) => stringValue(entry.event, "unknown"));
  const levels = countBy(entries, (entry) => stringValue(entry.level, "unknown"));
  const toolEntries = entries.filter((entry) => entry.event === "tool_call");
  const tools = summarizeTools(toolEntries);
  const http = summarizeHttp(entries.filter((entry) => entry.event === "http_request"));
  const sessions = entries.filter((entry) => entry.event === "mcp_session_created");
  const traces = summarizeTraces(entries, toolEntries);
  const toolEvents = summarizeToolEvents(entries);
  const workflowEventEntries = entries.filter(isWorkflowEvent);
  const workflowEvents = summarizeWorkflowEvents(workflowEventEntries);
  const verifyProfiles = summarizeVerifyProfiles(toolEntries, workflowEventEntries);
  const failureCategories = summarizeFailureCategories(entries, toolEntries);
  const efficiencyMetrics = summarizeEfficiencyMetrics(entries, toolEntries, workflowEventEntries, verifyProfiles, failureCategories);
  const timeline = buildTimeline(entries, options.bucket);
  const app = summarizeAppMetadata(entries);
  const threads = summarizeThreads(entries, traces);
  const insights = buildInsights({ tools, http, sessions, traces, toolEvents, threads, workflowEvents, verifyProfiles, failureCategories, efficiencyMetrics });

  return {
    generatedAt: new Date().toISOString(),
    inputs: loaded.files,
    filters: {
      since: options.since?.toISOString(),
      until: options.until?.toISOString(),
      appVersion: options.appVersion,
      gitCommit: options.gitCommit,
    },
    app,
    parse: {
      files: loaded.files.length,
      parsedEntries: entries.length,
      parsedLines: loaded.lines,
      emptyLines: loaded.emptyLines,
      skippedTextLines: loaded.skippedTextLines,
      parseErrors: loaded.errors.length,
      errors: loaded.errors.slice(0, 25),
    },
    range: { start, end },
    events: eventCounts,
    levels,
    sessions: {
      count: sessions.length,
      uniqueSessionPrefixes: uniqueCount(sessions.map((entry) => entry.sessionIdPrefix).filter(Boolean)),
    },
    tools,
    traces,
    toolEvents,
    workflowEvents,
    verifyProfiles,
    failureCategories,
    efficiencyMetrics,
    http,
    timeline,
    insights,
    threads,
  };
}

function coverageNoticeText() {
  return "Coverage note: tool_call failure rates only include calls that reached Workbridge. ChatGPT/OpenAI-side events are invisible unless the host records a tool_event_report via record_tool_event.";
}

function summarizeAppMetadata(entries) {
  const entriesWithAppMetadata = entries.filter(
    (entry) => entry.appName || entry.appVersion || entry.gitCommit || entry.gitBranch || entry.buildSource,
  );
  const latest = entriesWithAppMetadata
    .slice()
    .sort((a, b) => String(a.__ts ?? a.ts ?? "").localeCompare(String(b.__ts ?? b.ts ?? "")))
    .at(-1);

  return {
    current: latest
      ? {
        appName: latest.appName,
        appVersion: latest.appVersion,
        gitCommit: latest.gitCommit,
        gitBranch: latest.gitBranch,
        buildSource: latest.buildSource,
      }
      : undefined,
    versions: countBy(entriesWithAppMetadata, (entry) => stringValue(entry.appVersion, "unknown")),
    commits: countBy(entriesWithAppMetadata, (entry) => stringValue(entry.gitCommit, "unknown")),
    branches: countBy(entriesWithAppMetadata, (entry) => stringValue(entry.gitBranch, "unknown")),
    buildSources: countBy(entriesWithAppMetadata, (entry) => stringValue(entry.buildSource, "unknown")),
  };
}

function summarizeTools(toolEntries) {
  const byTool = new Map();
  for (const entry of toolEntries) {
    const tool = stringValue(entry.tool, "unknown");
    const item = byTool.get(tool) ?? {
      tool,
      calls: 0,
      success: 0,
      failures: 0,
      durationTotalMs: 0,
      durationMaxMs: 0,
      resultCharactersTotal: 0,
      returnedCharactersTotal: 0,
      resultLinesTotal: 0,
      requestedFilesTotal: 0,
      succeededFilesTotal: 0,
      failedFilesTotal: 0,
      truncations: 0,
      limited: 0,
      maxResultCharacters: 0,
      tracedCalls: 0,
    };

    const durationMs = numberValue(entry.durationMs);
    const resultCharacters = numberValue(entry.resultCharacters);
    const returnedCharacters = numberValue(entry.returnedCharacters);
    const resultLines = numberValue(entry.resultLines);
    const requestedFiles = numberValue(entry.requestedFiles);
    const succeededFiles = numberValue(entry.succeededFiles);
    const failedFiles = numberValue(entry.failedFiles);

    item.calls += 1;
    if (entry.success === false) item.failures += 1;
    else item.success += 1;
    item.durationTotalMs += durationMs;
    item.durationMaxMs = Math.max(item.durationMaxMs, durationMs);
    item.resultCharactersTotal += resultCharacters;
    item.returnedCharactersTotal += returnedCharacters;
    item.resultLinesTotal += resultLines;
    item.requestedFilesTotal += requestedFiles;
    item.succeededFilesTotal += succeededFiles;
    item.failedFilesTotal += failedFiles;
    item.maxResultCharacters = Math.max(item.maxResultCharacters, resultCharacters);
    if (entry.truncated === true) item.truncations += 1;
    if (entry.limited === true) item.limited += 1;
    if (entry.traceId) item.tracedCalls += 1;
    byTool.set(tool, item);
  }

  const items = Array.from(byTool.values())
    .map((item) => ({
      ...item,
      durationAvgMs: item.calls ? round(item.durationTotalMs / item.calls, 1) : 0,
      resultCharactersAvg: item.calls ? round(item.resultCharactersTotal / item.calls, 1) : 0,
      resultLinesAvg: item.calls ? round(item.resultLinesTotal / item.calls, 1) : 0,
      failureRate: item.calls ? round(item.failures * 100 / item.calls, 1) : 0,
      traceCoverageRate: item.calls ? round(item.tracedCalls * 100 / item.calls, 1) : 0,
    }))
    .sort((a, b) => b.calls - a.calls || a.tool.localeCompare(b.tool));

  return {
    totalCalls: toolEntries.length,
    totalFailures: items.reduce((total, item) => total + item.failures, 0),
    tracedCalls: items.reduce((total, item) => total + item.tracedCalls, 0),
    estimatedReadManyCallsSaved: items
      .filter((item) => item.tool === "read_many")
      .reduce((total, item) => total + Math.max(0, item.requestedFilesTotal - item.calls), 0),
    items,
  };
}

function summarizeTraces(entries, toolEntries) {
  const byTrace = new Map();
  for (const entry of entries) {
    if (entry.event !== "tool_trace_start" && entry.event !== "tool_trace_summary") continue;
    const traceId = stringValue(entry.traceId, "");
    if (!traceId) continue;
    const trace = byTrace.get(traceId) ?? blankTrace(traceId);
    if (entry.workspaceId) trace.workspaceId = entry.workspaceId;
    if (entry.label) trace.label = entry.label;
    if (entry.userIntent) trace.userIntent = entry.userIntent;
    if (entry.ts && !trace.startedAt) trace.startedAt = entry.ts;
    if (entry.event === "tool_trace_summary") {
      trace.hasSummary = true;
      trace.endedAt = entry.endedAt ?? entry.ts ?? trace.endedAt;
      trace.durationMs = numberValue(entry.durationMs, trace.durationMs);
      trace.outcome = entry.outcome ?? trace.outcome;
      trace.note = entry.note ?? trace.note;
      trace.totalToolCalls = numberValue(entry.totalToolCalls, trace.totalToolCalls);
      trace.successfulToolCalls = numberValue(entry.successfulToolCalls, trace.successfulToolCalls);
      trace.failedToolCalls = numberValue(entry.failedToolCalls, trace.failedToolCalls);
      trace.retries = numberValue(entry.retries, trace.retries);
      trace.retriesAfterFailure = numberValue(entry.retriesAfterFailure, trace.retriesAfterFailure);
      trace.eventReports = numberValue(entry.eventReports, trace.eventReports);
      trace.toolCounts = objectValue(entry.toolCounts, trace.toolCounts);
      trace.operationCounts = objectValue(entry.operationCounts, trace.operationCounts);
      trace.eventCategoryCounts = objectValue(entry.eventCategoryCounts, trace.eventCategoryCounts);
      trace.commandShapeCounts = objectValue(entry.commandShapeCounts, trace.commandShapeCounts);
      trace.commandShapesHidden = entry.commandShapesHidden === true;
    }
    byTrace.set(traceId, trace);
  }

  for (const entry of toolEntries) {
    const traceId = stringValue(entry.traceId, "");
    if (!traceId) continue;
    const trace = byTrace.get(traceId) ?? blankTrace(traceId);
    trace.workspaceId = entry.workspaceId ?? trace.workspaceId;
    trace.startedAt = earliestIso(trace.startedAt, entry.__ts ?? entry.ts);
    trace.endedAt = latestIso(trace.endedAt, entry.__ts ?? entry.ts);
    trace.derivedToolCalls += 1;
    trace.totalToolCalls = Math.max(trace.totalToolCalls, trace.derivedToolCalls);
    if (entry.success === false) {
      trace.derivedFailures += 1;
      trace.failedToolCalls = Math.max(trace.failedToolCalls, trace.derivedFailures);
    } else {
      trace.derivedSuccess += 1;
      trace.successfulToolCalls = Math.max(trace.successfulToolCalls, trace.derivedSuccess);
    }
    incrementObject(trace.toolCounts, stringValue(entry.tool, "unknown"));
    if (entry.operation) incrementObject(trace.operationCounts, stringValue(entry.operation, "unknown"));
    if (entry.eventCategory) incrementObject(trace.eventCategoryCounts, stringValue(entry.eventCategory, "unknown"));
    byTrace.set(traceId, trace);
  }

  const items = Array.from(byTrace.values())
    .map((trace) => {
      const total = Math.max(trace.totalToolCalls, trace.derivedToolCalls);
      const failures = Math.max(trace.failedToolCalls, trace.derivedFailures);
      const successes = Math.max(trace.successfulToolCalls, trace.derivedSuccess);
      const durationMs = trace.durationMs || durationBetween(trace.startedAt, trace.endedAt);
      return {
        traceId: trace.traceId,
        workspaceId: trace.workspaceId,
        label: trace.label,
        userIntent: trace.userIntent,
        startedAt: trace.startedAt,
        endedAt: trace.endedAt,
        durationMs,
        outcome: trace.outcome,
        hasSummary: trace.hasSummary,
        totalToolCalls: total,
        successfulToolCalls: successes,
        failedToolCalls: failures,
        failureRate: total ? round(failures * 100 / total, 1) : 0,
        retries: trace.retries,
        retriesAfterFailure: trace.retriesAfterFailure,
        eventReports: trace.eventReports,
        toolCounts: sortObject(trace.toolCounts),
        operationCounts: sortObject(trace.operationCounts),
        eventCategoryCounts: sortObject(trace.eventCategoryCounts),
        commandShapeCounts: sortObject(trace.commandShapeCounts),
        commandShapesHidden: trace.commandShapesHidden,
        note: trace.note,
      };
    })
    .sort((a, b) => String(b.startedAt ?? "").localeCompare(String(a.startedAt ?? "")) || b.totalToolCalls - a.totalToolCalls);

  return {
    count: items.length,
    withSummary: items.filter((item) => item.hasSummary).length,
    totalToolCalls: items.reduce((total, item) => total + item.totalToolCalls, 0),
    totalFailures: items.reduce((total, item) => total + item.failedToolCalls, 0),
    totalRetries: items.reduce((total, item) => total + item.retries, 0),
    totalRetriesAfterFailure: items.reduce((total, item) => total + item.retriesAfterFailure, 0),
    totalEventReports: items.reduce((total, item) => total + item.eventReports, 0),
    worstByFailures: [...items].sort((a, b) => b.failedToolCalls - a.failedToolCalls || b.totalToolCalls - a.totalToolCalls).slice(0, DEFAULT_TOP_N),
    busiest: [...items].sort((a, b) => b.totalToolCalls - a.totalToolCalls || b.failedToolCalls - a.failedToolCalls).slice(0, DEFAULT_TOP_N),
    items,
  };
}

function blankTrace(traceId) {
  return {
    traceId,
    workspaceId: undefined,
    label: undefined,
    userIntent: undefined,
    startedAt: undefined,
    endedAt: undefined,
    durationMs: 0,
    outcome: undefined,
    note: undefined,
    hasSummary: false,
    totalToolCalls: 0,
    successfulToolCalls: 0,
    failedToolCalls: 0,
    retries: 0,
    retriesAfterFailure: 0,
    eventReports: 0,
    toolCounts: {},
    operationCounts: {},
    eventCategoryCounts: {},
    commandShapeCounts: {},
    commandShapesHidden: true,
    derivedToolCalls: 0,
    derivedSuccess: 0,
    derivedFailures: 0,
  };
}

function summarizeToolEvents(entries) {
  const eventEntries = entries.filter((entry) => entry.event === "tool_event_report");
  return {
    count: eventEntries.length,
    categories: countBy(eventEntries, (entry) => stringValue(entry.category, "unknown")),
    operations: countBy(eventEntries, (entry) => stringValue(entry.operation, "unknown")),
    tools: countBy(eventEntries, (entry) => stringValue(entry.toolName, "unknown")),
    items: eventEntries.slice(-100).reverse().map((entry) => ({
      ts: entry.ts,
      traceId: entry.traceId,
      workspaceId: entry.workspaceId,
      toolName: entry.toolName,
      operation: entry.operation,
      category: entry.category,
      commandShape: entry.commandShape,
      note: entry.note,
    })),
  };
}

function isWorkflowEvent(entry) {
  if (!entry || typeof entry !== "object") return false;
  if (typeof entry.eventId === "string" && entry.eventId.startsWith("wfe_")) return true;
  if (typeof entry.workflowMode !== "string") return false;
  const event = stringValue(entry.event, "");
  return event === "workbridge_router" || event === "workbridge_verify" || event === "workflow_event";
}

function summarizeWorkflowEvents(eventEntries) {
  let hostBlocks = 0;
  let filesRead = 0;
  let filesChanged = 0;
  let testsRun = 0;
  let outputChars = 0;
  let durationTotalMs = 0;
  let durationMaxMs = 0;

  for (const entry of eventEntries) {
    hostBlocks += numberValue(entry.hostBlocks);
    filesRead += numberValue(entry.filesRead);
    filesChanged += numberValue(entry.filesChanged);
    testsRun += numberValue(entry.testsRun);
    outputChars += numberValue(entry.outputChars);
    const durationMs = numberValue(entry.durationMs);
    durationTotalMs += durationMs;
    durationMaxMs = Math.max(durationMaxMs, durationMs);
  }

  return {
    count: eventEntries.length,
    durationAvgMs: eventEntries.length ? round(durationTotalMs / eventEntries.length, 1) : 0,
    durationMaxMs,
    hostBlocks,
    filesRead,
    filesChanged,
    testsRun,
    outputChars,
    byMode: countBy(eventEntries, (entry) => stringValue(entry.workflowMode, "unknown")),
    byEvent: countBy(eventEntries, (entry) => stringValue(entry.event, "unknown")),
    byAction: countBy(eventEntries, (entry) => stringValue(entry.action, "unknown")),
    byTool: countBy(eventEntries, (entry) => stringValue(entry.tool, "unknown")),
    byStatus: countBy(eventEntries, (entry) => stringValue(entry.status, "unknown")),
    items: eventEntries.slice(-100).reverse().map((entry) => ({
      ts: entry.__ts ?? entry.createdAt ?? entry.ts,
      workflowMode: entry.workflowMode,
      event: entry.event,
      action: entry.action,
      tool: entry.tool,
      status: entry.status,
      outputChars: numberValue(entry.outputChars),
      durationMs: numberValue(entry.durationMs),
      note: entry.note,
    })),
  };
}

function summarizeVerifyProfiles(toolEntries, workflowEventEntries) {
  const byProfile = new Map();
  const add = (profile, status, durationMs, outputChars, outputOmitted, outputTruncated) => {
    const key = stringValue(profile, "unknown");
    const item = byProfile.get(key) ?? {
      profile: key,
      calls: 0,
      ok: 0,
      failed: 0,
      timedOut: 0,
      durationTotalMs: 0,
      durationMaxMs: 0,
      outputCharsTotal: 0,
      outputOmitted: 0,
      outputTruncated: 0,
    };
    item.calls += 1;
    if (status === "timed_out") item.timedOut += 1;
    else if (status === "ok" || status === "success") item.ok += 1;
    else item.failed += 1;
    item.durationTotalMs += numberValue(durationMs);
    item.durationMaxMs = Math.max(item.durationMaxMs, numberValue(durationMs));
    item.outputCharsTotal += numberValue(outputChars);
    if (outputOmitted === true) item.outputOmitted += 1;
    if (outputTruncated === true) item.outputTruncated += 1;
    byProfile.set(key, item);
  };

  for (const entry of toolEntries) {
    const tool = stringValue(entry.tool, "");
    const operation = stringValue(entry.operation, "");
    if (tool !== "workbridge_verify" && !operation.startsWith("verify_")) continue;
    const profile = operation.startsWith("verify_") ? operation.slice("verify_".length) : stringValue(entry.profile, "unknown");
    const status = entry.success === false ? "failed" : "ok";
    add(profile, status, entry.durationMs, entry.resultCharacters, entry.outputOmitted, entry.outputTruncated);
  }

  for (const entry of workflowEventEntries) {
    if (stringValue(entry.event, "") !== "workbridge_verify" && stringValue(entry.tool, "") !== "workbridge_verify") continue;
    add(entry.action, stringValue(entry.status, "unknown"), entry.durationMs, entry.outputChars, entry.outputOmitted, entry.outputTruncated);
  }

  const items = Array.from(byProfile.values())
    .map((item) => ({
      ...item,
      durationAvgMs: item.calls ? round(item.durationTotalMs / item.calls, 1) : 0,
      failureRate: item.calls ? round((item.failed + item.timedOut) * 100 / item.calls, 1) : 0,
    }))
    .sort((a, b) => b.calls - a.calls || a.profile.localeCompare(b.profile));

  return {
    totalCalls: items.reduce((total, item) => total + item.calls, 0),
    totalFailures: items.reduce((total, item) => total + item.failed + item.timedOut, 0),
    outputCharsTotal: items.reduce((total, item) => total + item.outputCharsTotal, 0),
    items,
  };
}

function summarizeFailureCategories(entries, toolEntries) {
  const failures = [];
  for (const entry of toolEntries) {
    if (entry.success !== false) continue;
    const category = categorizeFailure(entry);
    failures.push({ category, improvementAction: improvementActionForCategory(category), source: "tool_call", tool: entry.tool, operation: entry.operation, message: entry.error ?? entry.message ?? entry.result ?? entry.note });
  }
  for (const entry of entries) {
    if (!isWorkflowEvent(entry)) continue;
    const status = stringValue(entry.status, "ok");
    if (status === "ok" || status === "success") continue;
    const category = categorizeFailure(entry);
    failures.push({ category, improvementAction: improvementActionForCategory(category), source: "workflow_event", tool: entry.tool, operation: entry.action, message: entry.note });
  }
  return {
    total: failures.length,
    categories: countBy(failures, (item) => item.category),
    improvementActions: countBy(failures, (item) => item.improvementAction),
    items: failures.slice(-100).reverse(),
  };
}

function categorizeFailure(entry) {
  const haystack = [entry.error, entry.message, entry.result, entry.note, entry.operation, entry.action, entry.tool].map((value) => String(value ?? "").toLowerCase()).join("\n");
  if (haystack.includes("output validation") || haystack.includes("structured content") || haystack.includes("invalid_type")) return "schema_validation";
  if (haystack.includes("spawn") || haystack.includes("enoent") || haystack.includes("einval") || haystack.includes("failed to start")) return "spawn_process_start";
  if (haystack.includes("endline") && haystack.includes("file length")) return "line_range_or_locator_miss";
  if (haystack.includes("here-document") || haystack.includes("unexpected eof") || haystack.includes("unterminated") || haystack.includes("syntax error")) return "heredoc_or_quoting_syntax";
  if (haystack.includes("unicodeencodeerror") || haystack.includes("console encoding") || haystack.includes("charmap")) return "unicode_console_output";
  if (haystack.includes("oversized") || haystack.includes("maxbuffer") || haystack.includes("truncated") || haystack.includes("output limit")) return "oversized_output";
  if (haystack.includes("dirty worktree") || haystack.includes("working tree") || haystack.includes("uncommitted")) return "unexpected_dirty_worktree";
  if (haystack.includes("alternate path") || haystack.includes("fallback miss")) return "alternate_path_miss";
  if (haystack.includes("live smoke") || haystack.includes("external call") || haystack.includes("chat post") || haystack.includes("notification")) return "live_side_effect_attempt";
  if (haystack.includes("timed_out") || haystack.includes("timeout") || haystack.includes("sigterm") || haystack.includes("sigkill")) return "timeout";
  if (haystack.includes("workbridge_verify") || haystack.includes("verify_")) return "verify_failed";
  if (haystack.includes("host") || haystack.includes("safety") || haystack.includes("blocked") || haystack.includes("filtered")) return "safety_filter_block";
  return "other_failure";
}

function improvementActionForCategory(category) {
  const actions = {
    schema_validation: "switch_to_structured_schema",
    spawn_process_start: "use_fixed_profile_shell_wrapper",
    heredoc_or_quoting_syntax: "use_structured_edit_transport",
    unicode_console_output: "set_utf8_or_escape_output",
    line_range_or_locator_miss: "resolve_locator_before_edit",
    safety_filter_block: "split_sensitive_reference_from_secret_value",
    oversized_output: "use_bounded_report_or_tail",
    unexpected_dirty_worktree: "inspect_status_and_scope_commit",
    alternate_path_miss: "run_alternate_execution_path_detector",
    live_side_effect_attempt: "require_explicit_live_smoke_flag",
    timeout: "use_timeout_bounded_verify_profile",
    verify_failed: "inspect_failure_and_choose_structured_route",
    other_failure: "inspect_failure_and_choose_structured_route",
  };
  return actions[category] ?? "inspect_failure_and_choose_structured_route";
}

function summarizeEfficiencyMetrics(entries, toolEntries, workflowEventEntries, verifyProfiles, failureCategories) {
  const toolName = (entry) => stringValue(entry.tool, "");
  const operation = (entry) => stringValue(entry.operation, "");
  const text = (entry) => [entry.tool, entry.toolName, entry.operation, entry.action, entry.commandShape, entry.note, entry.error, entry.message, entry.result].map((value) => String(value ?? "").toLowerCase()).join("\n");
  const bashToolCalls = toolEntries.filter((entry) => ["bash", "run_shell"].includes(toolName(entry))).length;
  const bashEditLikeCalls = toolEntries.filter((entry) => ["bash", "run_shell"].includes(toolName(entry)) && /edit|write|replace|insert|tee|sed -i|>|>>/.test(text(entry))).length;
  const heredocLikeCalls = entries.filter((entry) => /heredoc|here-document|<<|unexpected eof|unterminated/.test(text(entry))).length;
  const listResourcesLikeEvents = entries.filter((entry) => /list.*resources|tool_registry|schema discovery/.test(text(entry))).length;
  const structuredEditCalls = toolEntries.filter((entry) => toolName(entry) === "apply_structured_edit" || operation(entry) === "apply_structured_edit").length;
  const unifiedPatchCalls = toolEntries.filter((entry) => toolName(entry) === "apply_unified_patch" || operation(entry) === "apply_unified_patch").length;
  const workbridgeVerifyCalls = verifyProfiles.totalCalls;
  const workbridgeVerifyFailureRate = workbridgeVerifyCalls ? round(verifyProfiles.totalFailures * 100 / workbridgeVerifyCalls, 1) : 0;
  const routerCalls = toolEntries.filter((entry) => toolName(entry) === "workbridge_router").length + workflowEventEntries.filter((entry) => stringValue(entry.event, "") === "workbridge_router").length;
  const routerVerifyPlanCalls = toolEntries.filter((entry) => toolName(entry) === "workbridge_router" && /verify_plan|suggest_verify/.test(operation(entry))).length + workflowEventEntries.filter((entry) => stringValue(entry.event, "") === "workbridge_router" && /verify_plan|suggest_verify/.test(stringValue(entry.action, ""))).length;
  const workflowEvents = workflowEventEntries.length;
  const incidentCount = failureCategories.total;
  const incidentImprovementHintCount = failureCategories.improvementActions.reduce((total, item) => total + item.count, 0);
  const oversizedOutputCount = countForKey(failureCategories.categories, "oversized_output");
  const truncatedOutputCount = toolEntries.filter((entry) => entry.truncated === true || entry.outputTruncated === true || entry.stdoutTruncated === true || entry.stderrTruncated === true).length;
  const retryAfterFailureCount = entries.reduce((total, entry) => total + numberValue(entry.retriesAfterFailure), 0);
  return {
    availableMetrics: {
      bashToolCalls,
      bashEditLikeCalls,
      heredocLikeCalls,
      listResourcesLikeEvents,
      structuredEditCalls,
      unifiedPatchCalls,
      workbridgeVerifyCalls,
      workbridgeVerifyFailureRate,
      routerCalls,
      routerVerifyPlanCalls,
      workflowEvents,
      incidentCount,
      incidentImprovementHintCount,
      oversizedOutputCount,
      truncatedOutputCount,
      retryAfterFailureCount,
    },
    unavailableMetrics: ["liveExternalServiceCalls", "hostFilteredCallsWithoutToolEvent"],
    toolingMix: [
      { key: "bash", count: bashToolCalls },
      { key: "structured_edit", count: structuredEditCalls },
      { key: "unified_patch", count: unifiedPatchCalls },
      { key: "workbridge_verify", count: workbridgeVerifyCalls },
      { key: "router", count: routerCalls },
    ].sort((a, b) => b.count - a.count || a.key.localeCompare(b.key)),
    incidentImprovementHints: failureCategories.improvementActions,
  };
}

function summarizeHttp(httpEntries) {
  const statuses = countBy(httpEntries, (entry) => String(entry.status ?? "unknown"));
  const paths = countBy(httpEntries, (entry) => stringValue(entry.path, "unknown"));
  let durationTotalMs = 0;
  let durationMaxMs = 0;
  let contentLengthTotal = 0;
  let contentLengthCount = 0;

  for (const entry of httpEntries) {
    const durationMs = numberValue(entry.durationMs);
    durationTotalMs += durationMs;
    durationMaxMs = Math.max(durationMaxMs, durationMs);
    const contentLength = numberValue(entry.contentLength, NaN);
    if (!Number.isNaN(contentLength)) {
      contentLengthTotal += contentLength;
      contentLengthCount += 1;
    }
  }

  return {
    count: httpEntries.length,
    durationAvgMs: httpEntries.length ? round(durationTotalMs / httpEntries.length, 1) : 0,
    durationMaxMs,
    contentLengthTotal,
    contentLengthAvg: contentLengthCount ? round(contentLengthTotal / contentLengthCount, 1) : 0,
    statuses,
    paths,
  };
}

function summarizeThreads(entries, traces) {
  const byThread = new Map();
  for (const entry of entries) {
    const identity = threadIdentity(entry);
    if (!identity) continue;
    const item = byThread.get(identity.id) ?? {
      id: identity.id,
      label: identity.label,
      mode: identity.mode,
      conversationIdHash: identity.conversationIdHash,
      startedAt: undefined,
      endedAt: undefined,
      durationMs: 0,
      events: 0,
      toolCalls: 0,
      failures: 0,
      retries: 0,
      events: 0,
      httpRequests: 0,
      maxHttpMs: 0,
      topTools: "",
      toolCounts: {},
    };
    item.startedAt = earliestIso(item.startedAt, entry.__ts ?? entry.ts);
    item.endedAt = latestIso(item.endedAt, entry.__ts ?? entry.ts);
    item.events += 1;
    if (entry.event === "tool_call") {
      item.toolCalls += 1;
      if (entry.success === false) item.failures += 1;
      incrementObject(item.toolCounts, stringValue(entry.tool, "unknown"));
    }
    if (entry.event === "tool_trace_summary") item.retries += numberValue(entry.retries);
    if (entry.event === "tool_event_report") item.events += 1;
    if (entry.event === "http_request") {
      item.httpRequests += 1;
      item.maxHttpMs = Math.max(item.maxHttpMs, numberValue(entry.durationMs));
    }
    byThread.set(identity.id, item);
  }

  const correlationItems = Array.from(byThread.values()).map((item) => ({
    ...item,
    durationMs: durationBetween(item.startedAt, item.endedAt),
    topTools: topObjectPairs(sortObject(item.toolCounts), 4),
  })).sort((a, b) => b.events - a.events || String(b.startedAt ?? "").localeCompare(String(a.startedAt ?? "")));

  if (correlationItems.length > 0) return { mode: "correlation", items: correlationItems };

  if (traces.items.length > 0) {
    return {
      mode: "trace",
      items: traces.items.map((item) => ({
        id: item.traceId,
        label: item.label ?? item.traceId,
        startedAt: item.startedAt,
        endedAt: item.endedAt,
        durationMs: item.durationMs,
        events: item.totalToolCalls,
        toolCalls: item.totalToolCalls,
        failures: item.failedToolCalls,
        retries: item.retries,
        events: item.eventReports,
        topTools: topObjectPairs(item.toolCounts, 4),
      })),
    };
  }

  return { mode: "none", items: [] };
}

function threadIdentity(entry) {
  const conversationIdHash = stringValue(entry.conversationIdHash, "");
  if (conversationIdHash) {
    return {
      id: `conversation:${conversationIdHash}`,
      label: `conversation:${conversationIdHash}`,
      mode: "conversation",
      conversationIdHash,
    };
  }

  const autoThreadId = stringValue(entry.autoThreadId, "");
  if (autoThreadId && !autoThreadId.startsWith("request:")) {
    return { id: `auto:${autoThreadId}`, label: autoThreadId, mode: "auto" };
  }

  const session = stringValue(entry.sessionIdPrefix, "");
  if (session) return { id: `session:${session}`, label: `session:${session}`, mode: "session" };

  return undefined;
}

function buildTimeline(entries, requestedBucket) {
  const timestamps = entries
    .map((entry) => (entry.__ts ? new Date(entry.__ts) : undefined))
    .filter(Boolean)
    .sort((a, b) => a - b);
  if (timestamps.length === 0) return { bucket: requestedBucket, items: [] };

  const spanMs = timestamps.at(-1) - timestamps[0];
  const bucket =
    requestedBucket === "auto"
      ? spanMs > 3 * 24 * 60 * 60 * 1000
        ? "day"
        : spanMs > 6 * 60 * 60 * 1000
          ? "hour"
          : "minute"
      : requestedBucket;

  const bucketCounts = new Map();
  for (const entry of entries) {
    if (!entry.__ts) continue;
    const key = bucketKey(new Date(entry.__ts), bucket);
    const item = bucketCounts.get(key) ?? {
      bucket: key,
      events: 0,
      toolCalls: 0,
      httpRequests: 0,
      failures: 0,
      retries: 0,
      events: 0,
      resultCharacters: 0,
    };
    item.events += 1;
    if (entry.event === "tool_call") {
      item.toolCalls += 1;
      item.resultCharacters += numberValue(entry.resultCharacters);
      if (entry.success === false) item.failures += 1;
    }
    if (entry.event === "tool_trace_summary") item.retries += numberValue(entry.retries);
    if (entry.event === "tool_event_report") item.events += 1;
    if (entry.event === "http_request") item.httpRequests += 1;
    bucketCounts.set(key, item);
  }

  return {
    bucket,
    items: Array.from(bucketCounts.values()).sort((a, b) => a.bucket.localeCompare(b.bucket)),
  };
}

function bucketKey(date, bucket) {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  const hour = String(date.getUTCHours()).padStart(2, "0");
  const minute = String(date.getUTCMinutes()).padStart(2, "0");
  if (bucket === "day") return `${year}-${month}-${day}`;
  if (bucket === "hour") return `${year}-${month}-${day} ${hour}:00`;
  return `${year}-${month}-${day} ${hour}:${minute}`;
}

function buildInsights({ tools, http, sessions, traces, toolEvents, threads, workflowEvents, verifyProfiles, failureCategories, efficiencyMetrics }) {
  const insights = [];
  const byTool = new Map(tools.items.map((item) => [item.tool, item]));
  const read = byTool.get("read") ?? byTool.get("read_file");
  const readMany = byTool.get("read_many");
  const workspaceSnapshot = byTool.get("workspace_snapshot");
  const openWorkspace = byTool.get("open_workspace");
  const shell = byTool.get("bash") ?? byTool.get("run_shell");
  const totalTruncations = tools.items.reduce((total, item) => total + item.truncations, 0);
  const largestResult = tools.items.reduce((max, item) => Math.max(max, item.maxResultCharacters), 0);

  if (threads?.items?.length > 0) {
    insights.push(`Auto thread correlation: ${threads.items.length} thread group(s) using conversationIdHash, autoThreadId, or sessionIdPrefix. Manual tool_trace tools are disabled for normal workflow.`);
  } else if (tools.totalCalls > 0) {
    insights.push("Auto thread correlation could not group this log set. Check whether request/session correlation fields are present in current logs.");
  }
  if (traces.count > 0) {
    insights.push(`Historical manual traces are present: ${traces.withSummary}/${traces.count} traces ended with summaries; ${tools.tracedCalls}/${tools.totalCalls} tool calls were trace-linked.`);
  }
  if (traces.totalRetriesAfterFailure > 0) {
    insights.push(`${traces.totalRetriesAfterFailure} 件の失敗後リトライがあります。新しいツール追加の前に Response Trace の失敗箇所を確認してください。`);
  }
  if (toolEvents.count > 0) {
    insights.push(`${toolEvents.count} 件の host/client filter event が記録されています。同じコマンド形状を繰り返さず、専用ツールか安全な指示形に寄せてください。`);
  }
  if (verifyProfiles?.totalCalls > 0) {
    insights.push(`workbridge_verify は ${verifyProfiles.totalCalls} 件記録されています。profile別の失敗率と出力量を Verify Profiles で確認できます。`);
  }
  if (workflowEvents?.count > 0) {
    insights.push(`workflow event は ${workflowEvents.count} 件記録されています。workflowMode別の効果比較に利用できます。`);
  }
  if (failureCategories?.total > 0) {
    insights.push(`失敗分類は ${failureCategories.total} 件あります。schema_validation / heredoc_or_quoting_syntax / timeout などの再発カテゴリを優先して潰してください。`);
  }
  if (efficiencyMetrics?.availableMetrics) {
    const metrics = efficiencyMetrics.availableMetrics;
    insights.push(`Efficiency metrics: bash=${metrics.bashToolCalls}, structured_edit=${metrics.structuredEditCalls}, verify=${metrics.workbridgeVerifyCalls}, incidents=${metrics.incidentCount}.`);
  }
  if (readMany?.requestedFilesTotal > 0) {
    insights.push(`read_many は ${readMany.requestedFilesTotal} 件のファイル読取を ${readMany.calls} 回に集約しています。推定削減コール数は ${tools.estimatedReadManyCallsSaved} 回です。`);
  }
  if (read && readMany && read.calls > readMany.calls * 2) {
    insights.push(`単体 read がまだ多いです（${read.calls} 回）。複数ファイル確認では read_many を優先すると往復を減らせます。`);
  }
  if (openWorkspace && !workspaceSnapshot) {
    insights.push("open_workspace 後に workspace_snapshot が使われていません。初動調査では workspace_snapshot を使うと探索コールを減らせます。大文字小文字は問わず英語タイトルは維持しています。");
  }
  if (totalTruncations > 0) {
    insights.push(`${totalTruncations} 件のツール結果が切り詰められています。grep_context、file_outline、小さめの read 範囲、read_chunks の導入候補です。`);
  }
  if (largestResult > 50_000) {
    insights.push(`最大ツール結果は ${formatNumber(largestResult)} 文字です。広範囲 read の前に grep_context / file_outline で絞り込む候補です。`);
  }
  if (shell && shell.calls > (read?.calls ?? 0) + (readMany?.calls ?? 0)) {
    insights.push(`shell 呼び出しが多めです（${shell.calls} 回）。調査用途の一部は、より安全な構造化ツールへ移せる可能性があります。`);
  }
  if (http.durationMaxMs > 1000) {
    insights.push(`遅い HTTP リクエストがあります。最大 ${http.durationMaxMs}ms です。操作が重く感じる場合は該当時刻のイベントを確認してください。`);
  }
  if (sessions.count > 5 && tools.totalCalls > 0 && sessions.count / tools.totalCalls > 0.5) {
    insights.push(`MCP session の作成が多めです（${sessions.count} 件）。継続する場合は再接続や OAuth 周りを確認してください。`);
  }
  if (insights.length === 0) {
    insights.push("現時点のログでは明確なボトルネックは見つかっていません。複数セッション分を蓄積してから優先度を判断してください。");
  }
  return insights;
}

function formatTextReport(report) {
  const lines = [];
  lines.push("Workbridge Ops Lens");
  lines.push("=================");
  lines.push(`Generated: ${report.generatedAt}`);
  lines.push(`Range: ${report.range.start ?? "n/a"} -> ${report.range.end ?? "n/a"}`);
  lines.push(`App: ${formatAppMetadata(report.app.current)} | versions: ${formatKeyCounts(report.app.versions)} | commits: ${formatKeyCounts(report.app.commits)}`);
  if (report.filters.appVersion || report.filters.gitCommit) {
    lines.push(`Filters: version=${report.filters.appVersion ?? "any"} commit=${report.filters.gitCommit ?? "any"}`);
  }
  lines.push(`Inputs: ${report.parse.files} file(s), ${report.parse.parsedEntries} parsed entries, ${report.parse.skippedTextLines} skipped text lines, ${report.parse.parseErrors} parse errors`);
  lines.push(`Traces: ${formatNumber(report.traces.count)} | trace summaries: ${formatNumber(report.traces.withSummary)} | retries: ${formatNumber(report.traces.totalRetries)} | events: ${formatNumber(report.traces.totalEventReports)}`);
  lines.push(coverageNoticeText());
  lines.push("");
  lines.push("Events");
  lines.push(formatTable(report.events, [["event", (row) => row.key], ["count", (row) => formatNumber(row.count)]]));
  lines.push("");
  lines.push("Tool calls");
  lines.push(formatTable(report.tools.items, [
    ["tool", (row) => row.tool],
    ["calls", (row) => formatNumber(row.calls)],
    ["ok", (row) => formatNumber(row.success)],
    ["fail", (row) => formatNumber(row.failures)],
    ["avg ms", (row) => formatNumber(row.durationAvgMs)],
    ["max ms", (row) => formatNumber(row.durationMaxMs)],
    ["trace %", (row) => `${formatNumber(row.traceCoverageRate)}%`],
  ]));
  lines.push("");
  lines.push("Verify profiles");
  lines.push(formatTable(report.verifyProfiles.items, [
    ["profile", (row) => row.profile],
    ["calls", (row) => formatNumber(row.calls)],
    ["ok", (row) => formatNumber(row.ok)],
    ["fail", (row) => formatNumber(row.failed + row.timedOut)],
    ["avg ms", (row) => formatNumber(row.durationAvgMs)],
    ["chars", (row) => formatNumber(row.outputCharsTotal)],
  ]));
  lines.push("");
  lines.push("Workflow events");
  lines.push(`Events: ${formatNumber(report.workflowEvents.count)} | hostBlocks: ${formatNumber(report.workflowEvents.hostBlocks)} | outputChars: ${formatNumber(report.workflowEvents.outputChars)} | avg ${formatNumber(report.workflowEvents.durationAvgMs)}ms`);
  lines.push(formatTable(report.workflowEvents.byMode, [["mode", (row) => row.key], ["count", (row) => formatNumber(row.count)]]));
  lines.push("");
  lines.push("Failure categories");
  lines.push(formatTable(report.failureCategories.categories, [["category", (row) => row.key], ["count", (row) => formatNumber(row.count)]]));
  lines.push("");
  lines.push("Efficiency metrics");
  lines.push(formatTable(Object.entries(report.efficiencyMetrics.availableMetrics).map(([key, value]) => ({ key, value })), [["metric", (row) => row.key], ["value", (row) => formatNumber(row.value)]]));
  lines.push(`Unavailable: ${report.efficiencyMetrics.unavailableMetrics.join(", ") || "none"}`);
  lines.push("");
  lines.push("Response traces");
  lines.push(formatTable(report.traces.items.slice(0, DEFAULT_TOP_N), [
    ["trace", (row) => row.traceId],
    ["label", (row) => row.label ?? ""],
    ["calls", (row) => formatNumber(row.totalToolCalls)],
    ["fail", (row) => formatNumber(row.failedToolCalls)],
    ["retry", (row) => formatNumber(row.retries)],
    ["event", (row) => formatNumber(row.eventReports)],
  ]));
  lines.push("");
  lines.push("HTTP");
  lines.push(`Requests: ${formatNumber(report.http.count)} | avg ${formatNumber(report.http.durationAvgMs)}ms | max ${formatNumber(report.http.durationMaxMs)}ms | request bytes ${formatNumber(report.http.contentLengthTotal)}`);
  lines.push("");
  lines.push("Insights");
  for (const insight of report.insights) lines.push(`- ${insight}`);
  return lines.join("\n");
}

function formatTable(rows, columns) {
  if (rows.length === 0) return "(none)";
  const table = [columns.map(([header]) => header), ...rows.map((row) => columns.map(([, valueFn]) => String(valueFn(row))))];
  const widths = columns.map((_, index) => Math.max(...table.map((row) => row[index].length)));
  return table
    .map((row, rowIndex) => {
      const line = row.map((cell, index) => cell.padEnd(widths[index])).join("  ");
      if (rowIndex === 0) return `${line}\n${widths.map((width) => "-".repeat(width)).join("  ")}`;
      return line;
    })
    .join("\n");
}

function renderHtmlReport(report) {
  const topTools = report.tools.items.slice(0, DEFAULT_TOP_N);
  const busyTraces = report.traces.busiest.slice(0, DEFAULT_TOP_N);
  const failureRate = report.tools.totalCalls ? round(report.tools.totalFailures * 100 / report.tools.totalCalls, 1) : 0;
  const traceCoverage = report.tools.totalCalls ? round(report.tools.tracedCalls * 100 / report.tools.totalCalls, 1) : 0;
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Workbridge Ops Lens</title>
  <style>${renderCss()}${renderCssOverrides()}</style>
</head>
<body>
<main>
  <section class="hero">
    <div>
      <div class="eyebrow">Workbridge / MCP Observability</div>
      <h1>Ops Lens</h1>
      <p class="muted">${escapeHtml(formatAppMetadata(report.app.current))} · Generated ${escapeHtml(report.generatedAt)} · ${escapeHtml(report.range.start ?? "n/a")} → ${escapeHtml(report.range.end ?? "n/a")}</p>
    </div>
    <div class="orb" aria-hidden="true"></div>
  </section>

  <section class="kpi-grid balanced">
    ${metricCard("Parsed entries", report.parse.parsedEntries, "log corpus")}
    ${metricCard("Tool calls", report.tools.totalCalls, `${formatNumber(failureRate)}% fail`)}
    ${metricCard("Threads", report.threads.items.length, `${escapeHtml(report.threads.mode)} mode`)}
    ${metricCard("Retries", report.traces.totalRetries, `${formatNumber(report.traces.totalRetriesAfterFailure)} after failure`)}
    ${metricCard("Tool Events", report.toolEvents.count, "host/client filter events")}
    ${metricCard("Verify calls", report.verifyProfiles.totalCalls, `${formatNumber(report.verifyProfiles.totalFailures)} fail`)}
    ${metricCard("Structured edits", report.efficiencyMetrics.availableMetrics.structuredEditCalls, "typed edits")}
    ${metricCard("Patch calls", report.efficiencyMetrics.availableMetrics.unifiedPatchCalls, "hash guarded")}
    ${metricCard("Incidents", report.efficiencyMetrics.availableMetrics.incidentCount, "improvement inputs")}
    ${metricCard("Workflow events", report.workflowEvents.count, `${formatNumber(report.workflowEvents.hostBlocks)} host blocks`)}
    ${metricCard("Read_many saved", report.tools.estimatedReadManyCallsSaved, "estimated calls")}
    ${metricCard("HTTP max", report.http.durationMaxMs, "ms")}
    ${metricCard("MCP sessions", report.sessions.count, `${report.sessions.uniqueSessionPrefixes} unique prefixes`)}
  </section>

  <section class="view-switch" aria-label="Dashboard view switch">
    <button type="button" class="active" data-view-button="overview">Overview</button>
    <button type="button" data-view-button="version">Version</button>
    <button type="button" data-view-button="thread">Thread</button>
    <button type="button" data-view-button="details">Details</button>
  </section>

  <section class="panel insight-panel" data-view-panel="overview">
    <h2>Coverage Notice</h2>
    <p class="muted">${escapeHtml(coverageNoticeText())}</p>
  </section>

  <section class="panel insight-panel" data-view-panel="version" hidden>
    <h2>App Version Scope</h2>
    <p class="muted">Filters: version <code>${escapeHtml(report.filters.appVersion ?? "any")}</code> · commit <code>${escapeHtml(report.filters.gitCommit ?? "any")}</code></p>
    <table><tbody>
      <tr><th>Versions</th><td>${escapeHtml(formatKeyCounts(report.app.versions))}</td></tr>
      <tr><th>Commits</th><td>${escapeHtml(formatKeyCounts(report.app.commits))}</td></tr>
      <tr><th>Branches</th><td>${escapeHtml(formatKeyCounts(report.app.branches))}</td></tr>
      <tr><th>Build sources</th><td>${escapeHtml(formatKeyCounts(report.app.buildSources))}</td></tr>
    </tbody></table>
  </section>

  <section class="panel insight-panel" data-view-panel="thread" hidden>
    <h2>Thread View</h2>
    <p class="muted">Mode: <code>${escapeHtml(report.threads.mode)}</code></p>
    ${renderThreadTable(report.threads.items)}
  </section>

  <section class="panel insight-panel" data-view-panel="overview">
    <h2>Priority Matrix</h2>
    <ul class="insights">${report.insights.map((item) => `<li>${escapeHtml(item)}</li>`).join("\n")}</ul>
  </section>

  <section class="charts large-charts" data-view-panel="overview">
    ${renderTraceStackChart("Response trace workload", busyTraces)}
    ${renderBarChart("Tool calls", topTools, "tool", "calls", "calls", "cyan")}
    ${renderBarChart("Failure hot spots", topTools, "tool", "failures", "fail", "red")}
    ${renderTimelineChart(report.timeline.items, report.timeline.bucket)}
    ${renderDonut("Trace outcome", traceOutcomeRows(report.traces.items))}
    ${renderBarChart("Max latency by tool", topTools, "tool", "durationMaxMs", "ms", "violet")}
  </section>

  <section class="panel"><h2 data-view-label="details">Response Trace Details</h2>${renderTraceTable(report.traces.items)}</section>
  <section class="panel"><h2 data-view-label="details">Tool Call Details</h2>${renderToolTable(report.tools.items)}</section>
  <section class="panel"><h2 data-view-label="details">Verify Profiles</h2>${renderVerifyProfileTable(report.verifyProfiles.items)}</section>
  <section class="panel two-col">
    <div><h2 data-view-label="details">Efficiency Summary KPI</h2>${renderMetricObjectTable(report.efficiencyMetrics.availableMetrics)}</div>
    <div><h2 data-view-label="details">Tooling Mix</h2>${renderKeyCountTable(report.efficiencyMetrics.toolingMix, "Route")}</div>
  </section>
  <section class="panel"><h2 data-view-label="details">Incident Improvement Hints</h2>${renderKeyCountTable(report.efficiencyMetrics.incidentImprovementHints, "Improvement")}</section>
  <section class="panel"><h2 data-view-label="details">Workflow Events</h2>${renderWorkflowEventTable(report.workflowEvents.items)}</section>
  <section class="panel two-col">
    <div><h2 data-view-label="details">Failure Categories</h2>${renderKeyCountTable(report.failureCategories.categories, "Category")}</div>
    <div><h2 data-view-label="details">Workflow Modes</h2>${renderKeyCountTable(report.workflowEvents.byMode, "Mode")}</div>
  </section>
  <section class="panel"><h2 data-view-label="details">Host/client Tool Events</h2>${renderEventReportTable(report.toolEvents.items)}</section>
  <section class="panel two-col">
    <div><h2 data-view-label="details">Events</h2>${renderKeyCountTable(report.events, "Event")}</div>
    <div><h2 data-view-label="details">HTTP Statuses</h2>${renderKeyCountTable(report.http.statuses, "Status")}</div>
  </section>
  <section class="panel"><h2 data-view-label="details">Inputs</h2><table><tbody>${report.inputs.map((input) => `<tr><td><code>${escapeHtml(input)}</code></td></tr>`).join("\n") || "<tr><td>No input files found.</td></tr>"}</tbody></table></section>
</main>
<script>${renderViewScript()}</script>
</body>
</html>`;
}

function renderViewScript() {
  return `const panels=()=>[...document.querySelectorAll('[data-view-panel]'),...[...document.querySelectorAll('[data-view-label]')].map((item)=>item.closest('.panel')).filter(Boolean)];const show=(view)=>{document.querySelectorAll('[data-view-button]').forEach((button)=>button.classList.toggle('active',button.getAttribute('data-view-button')===view));panels().forEach((panel)=>{const label=panel.getAttribute('data-view-panel')||panel.querySelector('[data-view-label]')?.getAttribute('data-view-label')||'overview';panel.hidden=label!==view;});};document.querySelectorAll('[data-view-button]').forEach((button)=>button.addEventListener('click',()=>show(button.getAttribute('data-view-button'))));show('overview');`;
}

function renderCss() {
  return `:root{color-scheme:dark;--bg0:#020617;--bg1:#08111f;--panel:rgba(15,23,42,.72);--panel2:rgba(30,41,59,.56);--line:rgba(148,163,184,.22);--ink:#e5f2ff;--muted:#94a3b8;--cyan:#22d3ee;--blue:#38bdf8;--violet:#a78bfa;--pink:#f472b6;--red:#fb7185;--green:#34d399;--amber:#fbbf24}*{box-sizing:border-box}body{margin:0;font:14px/1.5 Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:radial-gradient(circle at 20% 0%,rgba(34,211,238,.18),transparent 28%),radial-gradient(circle at 80% 8%,rgba(167,139,250,.22),transparent 30%),linear-gradient(135deg,var(--bg0),var(--bg1));color:var(--ink);min-height:100vh}body:before{content:"";position:fixed;inset:0;background-image:linear-gradient(rgba(148,163,184,.05) 1px,transparent 1px),linear-gradient(90deg,rgba(148,163,184,.05) 1px,transparent 1px);background-size:34px 34px;mask-image:linear-gradient(to bottom,black,transparent 85%);pointer-events:none}main{max-width:1440px;margin:0 auto;padding:34px}.hero{display:flex;align-items:center;justify-content:space-between;gap:24px;margin-bottom:22px}.eyebrow{color:var(--cyan);text-transform:uppercase;letter-spacing:.18em;font-size:12px;font-weight:800}h1{font-size:56px;line-height:1;margin:8px 0 10px;letter-spacing:-.05em;text-shadow:0 0 32px rgba(34,211,238,.35)}h2{font-size:18px;letter-spacing:-.02em;margin:0 0 14px}.muted{color:var(--muted)}.orb{width:132px;height:132px;border-radius:999px;background:radial-gradient(circle at 30% 30%,#fff,rgba(34,211,238,.92) 24%,rgba(167,139,250,.55) 58%,transparent 70%);box-shadow:0 0 80px rgba(34,211,238,.38),inset 0 0 34px rgba(255,255,255,.2);filter:saturate(1.2)}.kpi-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(165px,1fr));gap:14px;margin:20px 0}.card,.panel{position:relative;background:linear-gradient(180deg,rgba(15,23,42,.84),rgba(15,23,42,.58));border:1px solid var(--line);border-radius:22px;padding:18px;box-shadow:0 20px 70px rgba(0,0,0,.32),inset 0 1px rgba(255,255,255,.04);backdrop-filter:blur(18px);overflow:hidden}.card:after,.panel:after{content:"";position:absolute;inset:0;border-radius:inherit;padding:1px;background:linear-gradient(135deg,rgba(34,211,238,.38),transparent 35%,rgba(244,114,182,.28));mask:linear-gradient(#000 0 0) content-box,linear-gradient(#000 0 0);mask-composite:exclude;pointer-events:none}.label{color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:.1em}.metric{font-size:34px;font-weight:850;letter-spacing:-.04em;margin-top:5px}.sub{color:var(--muted);font-size:12px}.charts{display:grid;grid-template-columns:repeat(auto-fit,minmax(420px,1fr));gap:16px;margin:16px 0}.insight-panel{margin:16px 0}.insights{margin:0;padding-left:20px}.insights li{margin:7px 0}table{width:100%;border-collapse:collapse;border-radius:14px;overflow:hidden}th,td{text-align:left;padding:10px 12px;border-bottom:1px solid var(--line);vertical-align:top}th{color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:.08em;background:rgba(148,163,184,.06)}tr:hover td{background:rgba(34,211,238,.035)}code{background:rgba(34,211,238,.08);border:1px solid rgba(34,211,238,.24);border-radius:7px;padding:2px 6px;color:#b8f3ff}.charts svg{max-width:100%;height:auto;display:block}.bar-label{fill:var(--ink);font-size:12px}.bar-value{fill:var(--muted);font-size:12px}.axis{stroke:rgba(148,163,184,.28);stroke-width:1}.two-col{display:grid;grid-template-columns:1fr 1fr;gap:20px}.pill{display:inline-flex;align-items:center;border-radius:999px;border:1px solid var(--line);padding:2px 8px;color:var(--muted);background:rgba(148,163,184,.06);font-size:12px}.ok{color:var(--green)}.bad{color:var(--red)}.warn{color:var(--amber)}@media(max-width:760px){main{padding:20px}.hero{align-items:flex-start}.orb{display:none}h1{font-size:42px}.charts{grid-template-columns:1fr}.two-col{grid-template-columns:1fr}}`;
}

function renderCssOverrides() {
  return `main{max-width:1760px}.kpi-grid.balanced{grid-template-columns:repeat(4,minmax(0,1fr));gap:18px}.charts.large-charts{grid-template-columns:repeat(auto-fit,minmax(620px,1fr));gap:22px}.bar-label{font-size:15px}.bar-value{font-size:14px}.insights{font-size:15px;line-height:1.8}[hidden]{display:none!important}@media(max-width:1200px){.kpi-grid.balanced{grid-template-columns:repeat(2,minmax(0,1fr))}.charts.large-charts{grid-template-columns:1fr}}`;
}

function metricCard(label, value, sub = "") {
  return `<div class="card"><div class="label">${escapeHtml(label)}</div><div class="metric">${formatNumber(value)}</div>${sub ? `<div class="sub">${escapeHtml(sub)}</div>` : ""}</div>`;
}

function renderBarChart(title, rows, labelKey, valueKey, suffix, color = "cyan") {
  const chartRows = rows.filter((row) => numberValue(row[valueKey]) > 0).slice(0, DEFAULT_TOP_N);
  const width = 560;
  const rowHeight = 30;
  const left = 165;
  const right = 70;
  const height = Math.max(94, 52 + chartRows.length * rowHeight);
  const max = Math.max(1, ...chartRows.map((row) => numberValue(row[valueKey])));
  const fill = `var(--${color})`;
  const bars = chartRows.map((row, index) => {
    const y = 36 + index * rowHeight;
    const value = numberValue(row[valueKey]);
    const barWidth = Math.max(1, Math.round((width - left - right) * value / max));
    return `<text x="12" y="${y + 16}" class="bar-label">${escapeSvg(String(row[labelKey]))}</text><rect x="${left}" y="${y}" width="${barWidth}" height="18" rx="9" fill="${fill}" opacity=".9" /><text x="${left + barWidth + 8}" y="${y + 14}" class="bar-value">${escapeSvg(formatNumber(value))} ${escapeSvg(suffix)}</text>`;
  }).join("\n");
  return `<div class="panel"><h2>${escapeHtml(title)}</h2><svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeHtml(title)}"><line x1="${left}" x2="${left}" y1="26" y2="${height - 12}" class="axis" />${bars || `<text x="12" y="55" class="bar-label">No data</text>`}</svg></div>`;
}

function renderTraceStackChart(title, rows) {
  const chartRows = rows.slice(0, DEFAULT_TOP_N);
  const width = 760;
  const rowHeight = 34;
  const left = 230;
  const right = 80;
  const height = Math.max(112, 62 + chartRows.length * rowHeight);
  const max = Math.max(1, ...chartRows.map((row) => row.totalToolCalls + row.retries + row.eventReports));
  const bars = chartRows.map((row, index) => {
    const y = 44 + index * rowHeight;
    const scale = (width - left - right) / max;
    const ok = Math.max(0, row.totalToolCalls - row.failedToolCalls);
    const fail = row.failedToolCalls;
    const retry = row.retries;
    const event = row.eventReports;
    const okW = Math.round(ok * scale);
    const failW = Math.round(fail * scale);
    const retryW = Math.round(retry * scale);
    const eventW = Math.round(event * scale);
    const label = row.label ?? row.traceId;
    let x = left;
    const parts = [
      rect(x, y, okW, "var(--green)"),
      rect(x += okW, y, failW, "var(--red)"),
      rect(x += failW, y, retryW, "var(--amber)"),
      rect(x += retryW, y, eventW, "var(--pink)"),
    ].join("");
    return `<text x="12" y="${y + 17}" class="bar-label">${escapeSvg(shorten(label, 30))}</text>${parts}<text x="${left + okW + failW + retryW + eventW + 8}" y="${y + 14}" class="bar-value">${row.totalToolCalls} calls · ${row.failedToolCalls} fail · ${row.retries} retry</text>`;
  }).join("\n");
  return `<div class="panel"><h2>${escapeHtml(title)}</h2><div class="sub"><span class="ok">green</span> success · <span class="bad">red</span> failed · <span class="warn">amber</span> retries · pink events</div><svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeHtml(title)}"><line x1="${left}" x2="${left}" y1="34" y2="${height - 12}" class="axis" />${bars || `<text x="12" y="70" class="bar-label">No trace data yet</text>`}</svg></div>`;
}

function rect(x, y, width, fill) {
  if (width <= 0) return "";
  return `<rect x="${x}" y="${y}" width="${Math.max(2, width)}" height="18" rx="9" fill="${fill}" opacity=".92" />`;
}

function renderTimelineChart(items, bucket) {
  const chartRows = items.slice(-96);
  const width = 760;
  const height = 250;
  const bottom = 48;
  const left = 44;
  const max = Math.max(1, ...chartRows.map((item) => item.events));
  const usableWidth = width - left - 20;
  const barGap = 2;
  const barWidth = Math.max(2, Math.floor(usableWidth / Math.max(1, chartRows.length)) - barGap);
  const bars = chartRows.map((item, index) => {
    const x = left + index * (barWidth + barGap);
    const eventH = Math.max(1, Math.round((height - bottom - 30) * item.events / max));
    const failH = Math.round((height - bottom - 30) * item.failures / max);
    const retryH = Math.round((height - bottom - 30) * item.retries / max);
    const y = height - bottom - eventH;
    return `<rect x="${x}" y="${y}" width="${barWidth}" height="${eventH}" rx="3" fill="var(--violet)" opacity=".75"><title>${escapeHtml(item.bucket)}: ${item.events} events, ${item.toolCalls} tool calls, ${item.failures} failures, ${item.retries} retries</title></rect>${failH ? `<rect x="${x}" y="${height - bottom - failH}" width="${barWidth}" height="${failH}" rx="3" fill="var(--red)" />` : ""}${retryH ? `<rect x="${x}" y="${height - bottom - failH - retryH}" width="${barWidth}" height="${retryH}" rx="3" fill="var(--amber)" />` : ""}`;
  }).join("\n");
  const first = chartRows[0]?.bucket ?? "n/a";
  const last = chartRows.at(-1)?.bucket ?? "n/a";
  return `<div class="panel"><h2>Event timeline (${escapeHtml(bucket)})</h2><div class="sub">violet events · red failures · amber retries</div><svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Timeline"><line x1="${left}" x2="${width - 12}" y1="${height - bottom}" y2="${height - bottom}" class="axis" /><line x1="${left}" x2="${left}" y1="20" y2="${height - bottom}" class="axis" />${bars || `<text x="${left}" y="80" class="bar-label">No timestamped events</text>`}<text x="${left}" y="${height - 16}" class="bar-value">${escapeSvg(first)}</text><text x="${width - 230}" y="${height - 16}" class="bar-value">${escapeSvg(last)}</text></svg></div>`;
}

function traceOutcomeRows(items) {
  const counts = countBy(items, (item) => item.outcome ?? (item.hasSummary ? "unknown" : "derived"));
  return counts.map((row) => ({ label: row.key, value: row.count }));
}

function renderDonut(title, rows) {
  const total = rows.reduce((sum, row) => sum + row.value, 0);
  const radius = 70;
  const cx = 110;
  const cy = 100;
  const circumference = 2 * Math.PI * radius;
  let offset = 0;
  const colors = ["var(--green)", "var(--amber)", "var(--red)", "var(--cyan)", "var(--violet)"];
  const arcs = rows.map((row, index) => {
    const length = total ? circumference * row.value / total : 0;
    const dash = `${length} ${circumference - length}`;
    const arc = `<circle cx="${cx}" cy="${cy}" r="${radius}" fill="none" stroke="${colors[index % colors.length]}" stroke-width="22" stroke-dasharray="${dash}" stroke-dashoffset="${-offset}" transform="rotate(-90 ${cx} ${cy})" />`;
    offset += length;
    return arc;
  }).join("\n");
  const legend = rows.map((row, index) => `<div><span style="display:inline-block;width:10px;height:10px;border-radius:999px;background:${colors[index % colors.length]};margin-right:7px"></span>${escapeHtml(row.label)}: ${formatNumber(row.value)}</div>`).join("");
  return `<div class="panel"><h2>${escapeHtml(title)}</h2><div style="display:grid;grid-template-columns:220px 1fr;gap:12px;align-items:center"><svg viewBox="0 0 220 200"><circle cx="${cx}" cy="${cy}" r="${radius}" fill="none" stroke="rgba(148,163,184,.16)" stroke-width="22" />${arcs}<text x="${cx}" y="${cy - 2}" text-anchor="middle" class="bar-label" style="font-size:24px;font-weight:800">${formatNumber(total)}</text><text x="${cx}" y="${cy + 20}" text-anchor="middle" class="bar-value">traces</text></svg><div class="sub">${legend || "No trace outcomes yet"}</div></div></div>`;
}

function renderTraceTable(items) {
  if (items.length === 0) return "<p class=\"muted\">No historical manual traces. Manual tool trace tools are disabled for normal workflow; use Thread View for automatic correlation.</p>";
  return `<table><thead><tr><th>Trace</th><th>Label</th><th>Calls</th><th>Fail</th><th>Retry</th><th>Events</th><th>Duration</th><th>Top tools</th><th>Ops</th></tr></thead><tbody>${items.map((item) => `<tr><td><code>${escapeHtml(item.traceId)}</code><br /><span class="sub">${escapeHtml(item.startedAt ?? "")}</span></td><td>${escapeHtml(item.label ?? item.userIntent ?? "")}${item.hasSummary ? "" : "<br /><span class=\"pill\">derived</span>"}</td><td>${formatNumber(item.totalToolCalls)}</td><td class="${item.failedToolCalls ? "bad" : "ok"}">${formatNumber(item.failedToolCalls)}</td><td class="${item.retries ? "warn" : ""}">${formatNumber(item.retries)}</td><td class="${item.eventReports ? "warn" : ""}">${formatNumber(item.eventReports)}</td><td>${formatNumber(item.durationMs)} ms</td><td>${escapeHtml(topObjectPairs(item.toolCounts, 4))}</td><td>${escapeHtml(topObjectPairs(item.operationCounts, 4))}</td></tr>`).join("\n")}</tbody></table>`;
}

function renderToolTable(items) {
  if (items.length === 0) return "<p class=\"muted\">No tool_call entries.</p>";
  return `<table><thead><tr><th>Tool</th><th>Calls</th><th>OK</th><th>Fail</th><th>Fail %</th><th>Trace %</th><th>Avg ms</th><th>Max ms</th><th>Chars</th><th>Trunc</th></tr></thead><tbody>${items.map((item) => `<tr><td><code>${escapeHtml(item.tool)}</code></td><td>${formatNumber(item.calls)}</td><td class="ok">${formatNumber(item.success)}</td><td class="${item.failures ? "bad" : "ok"}">${formatNumber(item.failures)}</td><td>${formatNumber(item.failureRate)}%</td><td>${formatNumber(item.traceCoverageRate)}%</td><td>${formatNumber(item.durationAvgMs)}</td><td>${formatNumber(item.durationMaxMs)}</td><td>${formatNumber(item.resultCharactersTotal)}</td><td>${formatNumber(item.truncations)}</td></tr>`).join("\n")}</tbody></table>`;
}

function renderThreadTable(items) {
  if (!items || items.length === 0) return "<p class=\"muted\">No thread/session entries.</p>";
  return `<table><thead><tr><th>Thread</th><th>Start</th><th>End</th><th>Events</th><th>Tool calls</th><th>Fail</th><th>Retry</th><th>Events</th><th>Duration</th><th>Top tools</th></tr></thead><tbody>${items.map((item) => `<tr><td><code>${escapeHtml(item.label ?? item.id)}</code></td><td>${escapeHtml(item.startedAt ?? "")}</td><td>${escapeHtml(item.endedAt ?? "")}</td><td>${formatNumber(item.events)}</td><td>${formatNumber(item.toolCalls)}</td><td class="${item.failures ? "bad" : "ok"}">${formatNumber(item.failures)}</td><td>${formatNumber(item.retries)}</td><td>${formatNumber(item.events)}</td><td>${formatNumber(item.durationMs)} ms</td><td>${escapeHtml(item.topTools ?? "")}</td></tr>`).join("\n")}</tbody></table>`;
}

function renderVerifyProfileTable(items) {
  if (!items || items.length === 0) return '<p class="muted">No workbridge_verify entries.</p>';
  return `<table><thead><tr><th>Profile</th><th>Calls</th><th>OK</th><th>Fail</th><th>Timeout</th><th>Fail %</th><th>Avg ms</th><th>Max ms</th><th>Output chars</th><th>Omit</th><th>Trunc</th></tr></thead><tbody>${items.map((item) => `<tr><td><code>${escapeHtml(item.profile)}</code></td><td>${formatNumber(item.calls)}</td><td class="ok">${formatNumber(item.ok)}</td><td class="${item.failed ? "bad" : "ok"}">${formatNumber(item.failed)}</td><td class="${item.timedOut ? "warn" : "ok"}">${formatNumber(item.timedOut)}</td><td>${formatNumber(item.failureRate)}%</td><td>${formatNumber(item.durationAvgMs)}</td><td>${formatNumber(item.durationMaxMs)}</td><td>${formatNumber(item.outputCharsTotal)}</td><td>${formatNumber(item.outputOmitted)}</td><td>${formatNumber(item.outputTruncated)}</td></tr>`).join("")}</tbody></table>`;
}

function renderWorkflowEventTable(items) {
  if (!items || items.length === 0) return '<p class="muted">No workflow events.</p>';
  return `<table><thead><tr><th>Time</th><th>Mode</th><th>Event</th><th>Action</th><th>Tool</th><th>Status</th><th>Chars</th><th>Duration</th><th>Note</th></tr></thead><tbody>${items.map((item) => `<tr><td>${escapeHtml(item.ts ?? "")}</td><td><code>${escapeHtml(item.workflowMode ?? "")}</code></td><td>${escapeHtml(item.event ?? "")}</td><td>${escapeHtml(item.action ?? "")}</td><td>${escapeHtml(item.tool ?? "")}</td><td class="${item.status === "ok" || item.status === "success" ? "ok" : "bad"}">${escapeHtml(item.status ?? "")}</td><td>${formatNumber(item.outputChars)}</td><td>${formatNumber(item.durationMs)} ms</td><td>${escapeHtml(shorten(item.note ?? "", 120))}</td></tr>`).join("")}</tbody></table>`;
}

function renderEventReportTable(items) {
  if (items.length === 0) return "<p class=\"muted\">No host/client filter event reports.</p>";
  return `<table><thead><tr><th>Time</th><th>Trace</th><th>Tool</th><th>Operation</th><th>Category</th><th>Command shape</th><th>Note</th></tr></thead><tbody>${items.map((item) => `<tr><td>${escapeHtml(item.ts ?? "")}</td><td><code>${escapeHtml(item.traceId ?? "")}</code></td><td>${escapeHtml(item.toolName ?? "")}</td><td>${escapeHtml(item.operation ?? "")}</td><td>${escapeHtml(item.category ?? "")}</td><td><code>${escapeHtml(item.commandShape ?? "")}</code></td><td>${escapeHtml(item.note ?? "")}</td></tr>`).join("\n")}</tbody></table>`;
}

function renderKeyCountTable(rows, label) {
  if (rows.length === 0) return "<p class=\"muted\">No data.</p>";
  return `<table><thead><tr><th>${escapeHtml(label)}</th><th>Count</th></tr></thead><tbody>${rows.map((row) => `<tr><td><code>${escapeHtml(row.key)}</code></td><td>${formatNumber(row.count)}</td></tr>`).join("\n")}</tbody></table>`;
}

function renderMetricObjectTable(metrics) {
  const rows = Object.entries(metrics ?? {}).map(([key, value]) => ({ key, value }));
  if (rows.length === 0) return "<p class=\"muted\">No metrics available.</p>";
  return `<table><thead><tr><th>Metric</th><th>Value</th></tr></thead><tbody>${rows.map((row) => `<tr><td><code>${escapeHtml(row.key)}</code></td><td>${formatNumber(row.value)}</td></tr>`).join("\n")}</tbody></table>`;
}

function countBy(items, keyFn) {
  const counts = new Map();
  for (const item of items) {
    const key = keyFn(item);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return Array.from(counts.entries())
    .map(([key, count]) => ({ key, count }))
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
}

function printHelp() {
  console.log(`Workbridge log analyzer

Usage:
  node scripts/analyze-workbridge-logs.mjs [log-file-or-directory ...] [options]

Options:
  -i, --input <path>     Add a log file or directory. Defaults to ./logs when present.
      --html <path>      Write a self-contained HTML dashboard.
      --json             Print machine-readable JSON instead of text.
      --since <date>     Include entries at or after this timestamp.
      --until <date>     Include entries at or before this timestamp.
      --version <value>  Include entries for a specific appVersion.
      --commit <value>   Include entries for a specific gitCommit.
      --bucket <value>   auto, minute, hour, or day. Defaults to auto.
      --top <n>          Top rows for charts/tables. Defaults to ${DEFAULT_TOP_N}.
  -h, --help             Show this help.

Examples:
  npm run logs:analyze
  npm run logs:report
  node scripts/analyze-workbridge-logs.mjs logs --html reports/devspace-log-analysis.html
  node scripts/analyze-workbridge-logs.mjs logs --json
`);
}

function stringValue(value, fallback) {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

function numberValue(value, fallback = 0) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

function objectValue(value, fallback = {}) {
  return value && typeof value === "object" && !Array.isArray(value) ? { ...value } : { ...fallback };
}

function incrementObject(object, key) {
  object[key] = numberValue(object[key]) + 1;
}

function sortObject(object) {
  return Object.fromEntries(Object.entries(object).sort(([, a], [, b]) => numberValue(b) - numberValue(a)));
}

function topObjectPairs(object, limit) {
  const entries = Object.entries(object ?? {}).slice(0, limit);
  return entries.map(([key, value]) => `${key}:${value}`).join(", ");
}

function formatKeyCounts(rows, limit = 6) {
  if (!rows || rows.length === 0) return "n/a";
  return rows.slice(0, limit).map((row) => `${row.key}:${row.count}`).join(", ");
}

function countForKey(rows, key) {
  return numberValue(rows.find((row) => row.key === key)?.count);
}

function formatAppMetadata(metadata) {
  if (!metadata) return "n/a";
  const appName = metadata.appName ?? "devspace";
  const appVersion = metadata.appVersion ?? "unknown";
  const gitCommit = metadata.gitCommit ?? "unknown";
  const gitBranch = metadata.gitBranch ?? "unknown";
  const buildSource = metadata.buildSource ?? "unknown";
  return `${appName}@${appVersion} · ${gitCommit} · ${gitBranch} · ${buildSource}`;
}

function earliestIso(a, b) {
  if (!a) return b;
  if (!b) return a;
  return new Date(a) <= new Date(b) ? a : b;
}

function latestIso(a, b) {
  if (!a) return b;
  if (!b) return a;
  return new Date(a) >= new Date(b) ? a : b;
}

function durationBetween(start, end) {
  if (!start || !end) return 0;
  const duration = new Date(end).getTime() - new Date(start).getTime();
  return Number.isFinite(duration) && duration > 0 ? duration : 0;
}

function round(value, digits) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function uniqueCount(values) {
  return new Set(values).size;
}

function formatNumber(value) {
  if (typeof value !== "number") return String(value ?? "");
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 }).format(value);
}

function shorten(value, max) {
  const text = String(value ?? "");
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function escapeSvg(value) {
  return escapeHtml(value);
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

main().catch((error) => {
  console.error(errorMessage(error));
  process.exitCode = 1;
});
