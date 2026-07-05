# Workbridge Session Review

A small session-level review layer for Workbridge.

This is intentionally separate from tool-call counts and the efficiency ledger. The goal is not precise scoring. The goal is to record, once per work session, how large the work was, how long it took, whether it finished, and what slowed it down.

## Default storage

```text
.devspace/session-reviews/events.jsonl
```

Override:

```powershell
$env:WORKBRIDGE_SESSION_REVIEW_PATH="reports/session-reviews.jsonl"
```

## Fields

| Field | Meaning |
| --- | --- |
| `sessionId` | Generated unless supplied. |
| `task` | Short session goal. |
| `workSize` | `S`, `M`, `L`, or `XL`. |
| `result` | `done`, `partial`, `blocked`, or `failed`. |
| `efficiency` | `good`, `normal`, `bad`, or `unknown`. |
| `mainDelayReason` | Main reason time was lost, if any. |
| `startedAt` / `endedAt` | ISO timestamps when available. |
| `durationMinutes` | Approximate session duration. |
| `completedSummary` | What actually got done. |
| `nextAction` | Next concrete step. |
| `notes` | Optional context. |

## Work size

| Size | Use when |
| --- | --- |
| `S` | Single small check, doc update, or tiny fix. |
| `M` | Several related edits/checks or a contained implementation. |
| `L` | Multi-file implementation, validation, or non-trivial debugging. |
| `XL` | Long, multi-phase, uncertain, or repeated recovery work. |

## Result

| Result | Meaning |
| --- | --- |
| `done` | Intended work completed. |
| `partial` | Some useful progress, but planned work remains. |
| `blocked` | Could not proceed due to external/tool/environment block. |
| `failed` | Attempt did not produce useful progress or needs rollback/rework. |

## Delay reasons

Use one primary reason: `none`, `tool_error`, `connection_error`, `schema_discovery`, `large_output`, `wrong_direction`, `user_correction`, `test_failure`, or `other`.

## Usage

Dry-run:

```powershell
npm run session:review -- --task "Workbridge cleanup" --size M --result partial --duration-minutes 65 --delay wrong_direction --efficiency bad --summary "Renamed surface and updated memos" --next "Compress local_memos" --dry-run
```

Append one review event:

```powershell
npm run session:review -- --task "Workbridge cleanup" --size M --result partial --duration-minutes 65 --delay wrong_direction --efficiency bad --summary "Renamed surface and updated memos" --next "Compress local_memos"
```

## How to use it

At the end of a session, record one event. Use existing efficiency logs for low-level tool telemetry. Use session review for the human-level question: was the amount of work reasonable for the elapsed time, did it finish, what slowed it down, and what should happen next?

Only add detailed scoring later if this summary is not enough.

## Automatic session report

`session:review` is manual. For automatic rough estimates from existing Workbridge telemetry, use:

```powershell
npm run session:report
```

The report groups `.devspace/efficiency/events.jsonl` by `workspaceId` / `autoThreadId` and splits sessions when there is a long idle gap.

Default idle gap: 30 minutes.

```powershell
npm run session:report -- --gap-minutes 45
npm run session:report -- --json
```

The automatic report estimates workspace/session start and end time, elapsed minutes, tool call count, read-like calls, write-like calls, process calls, failed calls, rough work size, rough efficiency, and visible delay reason.

The current efficiency ledger does not always record exact files read, lines read, files changed, or lines written for every tool. Current rough proxies are read-like calls, write-like calls, process calls, command length, result characters when available, additions/removals when available, and elapsed minutes. Add exact file/line counters to low-level telemetry later only if this coarse report is not enough.
