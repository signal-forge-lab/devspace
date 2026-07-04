# Workbridge Ops Lens / Log Analysis

Workbridge writes JSONL-style logs to stdout and, by default, also writes them
directly to `logs/devspace_YYYYMMDD_HHMMSS.jsonl`. This keeps logs available for
analysis even when the server is started without `tee`.

```bash
DEVSPACE_WIDGETS=off \
DEVSPACE_TRUST_PROXY=0 \
DEVSPACE_LOG_FORMAT=json \
DEVSPACE_LOG_REQUESTS=1 \
DEVSPACE_LOG_TOOL_CALLS=1 \
DEVSPACE_LOG_SHELL_COMMANDS=0 \
node dist/cli.js serve
```

Use `DEVSPACE_LOG_FILE=0` to disable file logging, `DEVSPACE_LOG_DIR` to change
the output directory, or `DEVSPACE_LOG_FILE_NAME` to force a specific filename.

Each JSON log entry includes the current application metadata when available:

```text
appName
appVersion
gitCommit
gitBranch
buildSource
```

Workbridge also writes a `server_start` JSON event at startup with the same common
metadata plus local/public endpoint and runtime logging settings. This makes it
possible to distinguish logs from different local builds or commits.

## Text summary

```bash
npm run logs:analyze
```

By default, the analyzer reads `logs/` and `.devspace/workflow-events/` when those directories exist.

You can pass files or directories explicitly:

```bash
npm run logs:analyze -- logs .devspace/workflow-events/devspace_20260623_220714.jsonl
npm run logs:analyze -- logs .devspace/workflow-events
```

## HTML dashboard

```bash
npm run logs:report
```

This writes:

```text
reports/devspace-log-analysis.html
```

The HTML report is self-contained and can be opened directly in a browser. The
current dashboard is **Workbridge Ops Lens**: a richer glass/neon-style UI for
visually reviewing MCP/tool efficiency and automatically correlated work threads.

It includes:

- high-level counts for parsed entries, tool calls, HTTP requests, MCP sessions,
  skipped non-JSON startup lines, parse errors, and estimated `read_many` saved calls
- thread grouping by `conversationIdHash` when an allowlisted conversation-like
  header is present, otherwise by workspace-based `autoThreadId`, then
  `sessionIdPrefix` for HTTP-only fallback
- historical manual trace metrics when old `tool_trace_start` / `tool_trace_end`
  events exist in older logs
- visual charts for tool call counts, failure hot spots, event timeline, trace
  outcomes when available, and max latency by tool
- `workbridge_verify` profile summaries, including calls, failures, duration, output
  size, omitted output count, and truncated output count
- workflow event summaries from `.devspace/workflow-events/`, grouped by
  `workflowMode`, event, action, tool, and status
- failure categories such as `schema_validation`,
  `line_range_end_exceeds_file_length`, `heredoc_or_quoting_syntax`, `timeout`,
  and `verify_failed`
- detailed tables for correlated threads, historical response traces, tool calls,
  verify profiles, workflow events, minimum host-side filter reports, HTTP
  statuses, and event types
- priority hints for follow-up improvements


## Workflow and verify analysis

`record_workflow_event`, `workbridge_router`, and `workbridge_verify` can write local
workflow events to `.devspace/workflow-events/events.jsonl`. These files are
local operational data and are not committed by default.

The analyzer now includes:

```text
workflowEvents.count
workflowEvents.byMode
workflowEvents.byEvent
workflowEvents.byAction
workflowEvents.byTool
workflowEvents.byStatus
verifyProfiles.items
failureCategories.categories
```

This is intended to compare `baseline`, `router`, `zip_first`, and
`zip_first_router` workflows by tool-call count, failure category, output volume,
and verification profile behavior.

## JSON output

```bash
npm run logs:analyze -- logs .devspace/workflow-events --json
```

This is useful for later automation or for feeding the summary into another
review tool.

## Version and date filtering

```bash
npm run logs:analyze -- logs .devspace/workflow-events --since 2026-06-23T00:00:00+09:00
npm run logs:analyze -- logs .devspace/workflow-events --since 2026-06-23 --until 2026-06-24
npm run logs:analyze -- logs .devspace/workflow-events --version 1.1.0
npm run logs:analyze -- logs .devspace/workflow-events --commit 6eeb66c
npm run logs:report -- --version 1.1.0
npm run logs:report -- --commit 6eeb66c
```

## Timeline bucket

```bash
npm run logs:analyze -- logs .devspace/workflow-events --bucket minute
npm run logs:analyze -- logs .devspace/workflow-events --bucket hour
npm run logs:analyze -- logs .devspace/workflow-events --bucket day
```

The default is `auto`.

## What the analyzer is meant to answer

Use this report to decide which Workbridge optimization to prioritize next:

- If single-file `read` remains frequent, prefer improving `read_many` usage or
  adding `grep_context`.
- If large results or truncations appear, prioritize `grep_context`,
  `file_outline`, or `read_chunks`.
- If `open_workspace` appears without `workspace_snapshot`, update the workflow
  to run `workspace_snapshot` after opening the workspace.
- If session creation is frequent, investigate reconnect/OAuth behavior.
- If shell calls dominate inspection work, consider moving common inspections to
  safer structured tools.
- If thread grouping is weak, check whether current logs include
  `conversationIdHash`, `autoThreadId`, or `sessionIdPrefix` fields.
- If retries-after-failure or host-side filters appear, prioritize a dedicated
  structured tool or safer prompt shape before repeating the same tool call.

The analyzer intentionally reports counts and sizes only. It does not include
file contents, shell command output bodies, or source snippets in the generated
HTML dashboard. When `DEVSPACE_LOG_SHELL_COMMANDS=0`, shell command shapes remain
hidden except for sanitized `record_tool_event.commandShape` values that were
explicitly recorded for analysis. Keep filter reports minimal by default:
`toolName`, `operation`, and `category`; add `commandShape` or `note` only
when the minimum form is stable and more detail is necessary.

Workbridge startup lines such as `devspace listening on ...` are not JSON. The
analyzer skips those as text lines instead of treating them as malformed JSON.

## Startup smoke integration

After changing workflow events, verify profiles, or report rendering, run `npm run smoke:startup` before restarting Workbridge and then follow `docs/startup-smoke.md` for manual MCP checks.
