# Workbridge Upstream Boundary Review — 2026-07-26

> Historical note: the fixed seven-tool policy described below was superseded
> on 2026-08-07 by the upstream Codex/review surface plus explicit Workbridge
> extensions and a reviewed schema baseline. The measurements and extraction
> decisions remain historical evidence for that earlier baseline.

## Scope

This review evaluates the remaining Workbridge changes in upstream-owned files
after the Session Monitor, tool registration, Workspace Action runner, and
logging extractions.

Review baseline:

```text
downstream branch: workbridge-fixed-surface
downstream HEAD: c627cde
upstream base: 0d9b60c
upstream-only commits: 0
downstream-only commits: 29
```

The review uses the mandatory rule from
`docs/WORKBRIDGE_UPSTREAM_REBASE_POLICY.md`: perform another extraction only
when it measurably reduces the upstream patch surface or creates a narrow,
stable integration boundary. File size alone is not a reason to refactor.

## Current upstream patch surface

| File | Added | Removed | Diff hunks | Review decision |
| --- | ---: | ---: | ---: | --- |
| `src/server.ts` | 233 | 450 | 98 | Keep; no broad extraction |
| `src/cli.ts` | 84 | 33 | 28 | One bounded extraction candidate |
| `src/config.ts` | 91 | 33 | 19 | Keep; policy and security integration |
| `src/process-sessions.ts` | 81 | 27 | 25 | T3 complete; keep current boundary |
| `src/workspaces.ts` | 40 | 19 | 10 | Keep; localized safety behavior |
| `src/logger.ts` | 25 | 1 | 5 | T4 complete; keep current boundary |
| `src/artifact-tools.ts` | 3 | 1 | 3 | Keep; already a minimal injection hook |

## `src/server.ts`

### Remaining changes

The remaining diff is distributed because the fixed seven-tool contract and
Workbridge safety behavior touch upstream tool definitions and request handling
at their actual integration points. It includes:

- removal or disabling of upstream tools outside the fixed seven-tool surface;
- Workbridge descriptions and workspace reuse instructions on retained tools;
- path redaction for workspace, tool, command, and diagnostic output;
- thin registration calls into Workbridge-owned tool, Monitor, Soft Pause, and
  lifecycle modules;
- MCP request/session metadata passed into `McpSessionLifecycle`;
- request classification and security-sensitive logging fields;
- local Session Monitor route and shutdown hooks;
- branding and package-version integration.

### Decision

Do not extract the retained `open_workspace`, `read`, or `apply_patch` handlers.
They are upstream handlers with Workbridge contract adjustments. Moving them
would duplicate or replace upstream structure and would make later rebases more
difficult.

Do not perform a broad server route or runtime split. The large hunk count is no
longer caused by one embedded Workbridge subsystem; it is primarily the visible
effect of an intentionally different public contract and localized security
behavior.

The small MCP metadata parsers and response-redaction helpers could be moved to
Workbridge-owned helper modules, but doing so would remove relatively few
integration hunks. Defer that change until an actual upstream conflict or a
feature change makes the boundary valuable.

## `src/cli.ts`

### Remaining changes

The CLI diff contains four categories:

- Workbridge branding text;
- fixed-surface startup diagnostics;
- the `control pause|status` Soft Pause command and startup-time implicit clear;
- removal of upstream setup behavior that would expose retired dynamic
  subagent/tool configuration.

### Decision

The only confirmed bounded extraction candidate is:

```text
Soft Pause command implementation
startup diagnostic line generation
```

A future task may move those into a Workbridge-owned CLI helper while leaving
only command dispatch and one startup-diagnostic call in `src/cli.ts`.

Do not move branding substitutions or removed upstream setup behavior merely to
reduce the displayed diff. Those changes must remain at the user-facing CLI
integration points.

Priority: **medium**. This is the next structural extraction candidate, but it
is not required before adding the rebase verification command or accepting a
new upstream update.

## `src/config.ts`

### Remaining changes

The config diff implements accepted Workbridge policy and security boundaries:

- fixed `codex` tool mode and disabled widget surface;
- always-enabled artifact and skill support required by the fixed contract;
- disabled dynamic subagent exposure;
- persistent logging and rotation settings;
- OAuth client retention and authorization rate limits;
- workspace-session maximum age;
- Workbridge branding and legacy OAuth scope compatibility.

### Decision

Keep the current file boundary. Extracting parsers into a separate module would
move lines but would not remove the required `ServerConfig` shape or the
Workbridge assignments inside `loadConfig`. The expected rebase benefit is
therefore limited.

Reconsider only when upstream changes its configuration architecture or adopts
equivalent security settings.

## `src/workspaces.ts`

### Remaining changes

- real-path and directory validation for working directories;
- persistent workspace-session start-time lookup;
- explicit workspace reuse error guidance;
- deterministic skill-path resolution;
- prompt-safe path formatting.

### Decision

Keep these changes in place. They are localized safety and correctness behavior
at the upstream workspace boundary. Moving them would add indirection without
reducing the required integration points.

## `src/artifact-tools.ts`

### Remaining changes

The file accepts an optional `registerTool` function and uses it for
`download_artifact`. This allows the Workbridge Soft Pause and Session Monitor
registrars to wrap the tool without copying the upstream artifact handler.

### Decision

This is already the desired minimal adapter hook. No further change is needed.

## `src/process-sessions.ts` and `src/logger.ts`

T3 and T4 established the intended boundaries:

- Workspace Action process execution is owned by
  `src/workspace-action-process-runner.ts`;
- Workbridge JSONL, compact console, and Monitor publishing behavior is owned by
  `src/workbridge-logging.ts`.

Do not split these upstream files further without a concrete failure or upstream
conflict.

## Recommended next maintenance order

1. Use `npm run verify:rebase` after every upstream rebase and before accepting
   the integrated result.
2. Continue live acceptance of Session Monitor and Desktop Monitor.
3. When further patch-surface reduction is desired, review and extract only the
   Soft Pause CLI command and startup diagnostic formatting from `src/cli.ts`.
4. Leave `src/server.ts`, `src/config.ts`, `src/workspaces.ts`, and
   `src/artifact-tools.ts` unchanged unless a concrete upstream conflict,
   regression, or approved feature requires a new boundary.
5. Re-run this review after the next upstream rebase because file ownership and
   upstream equivalents may change.

## Explicit non-actions

This review does not recommend:

```text
server.ts wholesale extraction
core retained tool-handler extraction
config parser splitting for file-size reasons
workspace registry abstraction layers
artifact tool duplication
additional process-session or logger splitting
public tool-schema changes
```
