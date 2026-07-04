# Workbridge Workflow Router v1

`workbridge_router` is a small, read-only/planning-oriented control interface for Workbridge workflow experiments. It is not a natural-language shell runner.

## Purpose

Use Router v1 when a task can be expressed with small structured fields:

- `action`
- `workflowMode`
- `targets.paths`
- `refs`
- `limits`
- short `intent`

Do not pass long file contents, shell commands, huge diffs, or full `newContent` payloads to the router.

## Workflow modes

- `baseline`: existing individual-tool workflow.
- `zip_first`: ZIP-first workflow without router control.
- `router`: router workflow without ZIP-first assumptions.
- `zip_first_router`: combined experiment mode.

Record the mode so later logs can compare tool-call count, output size, host blocks, and retry count.

## Actions

### `start`

Creates a lightweight job reference and returns the basic usage rule. Use this at the beginning of a router experiment.

### `snapshot`

Returns a bounded git status and tracked-file summary. Use this instead of broad status/search commands.

### `inspect`

Reads bounded previews for explicit target paths. Keep `targets.paths` small and set `limits`.

### `resolve_locator`

Resolves a small locator into line/hash/preview candidates. Use this before `apply_structured_edit` when exact text replacement is risky.

### `check_invariants`

Runs generic token, regex, or structured-value checks. Use this for version drift, old import remnants, and cross-file consistency.

### `summarize`

Returns a bounded git status summary and next-step recommendation.

### `verify_plan` / `suggest_verify`

Returns a bounded verification plan made only of fixed `workbridge_verify` profiles.
It combines explicit `targets.paths` with current `git status --short` paths and
suggests profiles such as `git_status_check`, `git_diff_check`,
`typecheck_only`, `workflow_tools_test`, `npm_test`, and `build`.

The router does not execute validation commands and does not accept arbitrary
shell commands. Use `workbridge_verify` to execute the suggested profiles.


## Unified operating policy

For task classes, reference-vs-secret handling, structured transport, verification routing, and incident-to-improvement behavior, see `docs/workbridge-operating-policy.md`. Router actions should support that policy by keeping requests typed, bounded, and reusable across projects.

The shared classifier returns `taskClass`, `risk`, `efficiencyGoal`, `recommendedSequence`, `requiredChecks`, `transportRecommendation`, `blockedPattern`, and `improvementHint`. Use those fields to pick the next structured route; do not interpret higher risk as a reason to abandon the task.

Router `verify_plan` may accept a `taskClass` and returns the verification policy result with fixed `workbridge_verify` profiles. For `large_edit_refactor`, the plan also includes bounded alternate execution path candidates so fallback, CLI, runtime, UI, config, generated, and test paths can be reviewed before editing.

## Standard flow

```text
1. workbridge_router action=start workflowMode=router
2. workbridge_router action=snapshot
3. workbridge_router action=inspect targets.paths=[...]
4. workbridge_router action=resolve_locator or check_invariants as needed
5. For edits, use apply_unified_patch or apply_structured_edit with dryRun first
   - Use `contentEncoding="base64"` only as typed transport for special characters or larger templates, with decoded size validation and hash guards.
6. Optionally call `workbridge_router action=verify_plan` or `suggest_verify` to get fixed `workbridge_verify` profile suggestions
7. Verify with `workbridge_verify` profiles such as `typecheck_only`, `related_tests`, `npm_test`, `build`, `git_diff_check`, `git_diff_cached_check`, or `git_status_check`
8. record_workflow_event for comparison logs when useful
```

## Prohibited router payloads

Do not send these to `workbridge_router`:

- long file bodies
- huge patches
- full-file `newContent`
- shell commands
- `git commit` instructions
- combined commands such as `npm test && npm run build && git diff --check`

Use `apply_unified_patch`, `apply_structured_edit`, `check_workspace_invariants`, or dedicated git tools instead.

## Sensitive Integration

For API, token, webhook, or credential-related work, pass env var names and config keys as typed references. Do not pass live secret values, cookies, sessions, Authorization header values, or live tokens through router, edit transport, logs, or workflow events. Prefer config-only or mock-first sequencing until a live smoke flag is explicitly approved.

## Incident and Metrics

Incidents should be classified into reusable categories and mapped to improvement actions such as structured schema, structured edit transport, locator resolution, bounded output, alternate path detection, or explicit live-smoke gating. `logs:report` exposes efficiency metrics for tooling mix, verify usage, incidents, improvement hints, truncation, and retries.

## Tool description rule

The router exists to keep ChatGPT requests small and let Workbridge handle bounded inspection and recommendations. If a request starts becoming a large free-form instruction, split it into smaller router actions or use the lower-level workflow primitive directly.


## Skill

The companion skill lives at `skills/workbridge-workflow/SKILL.md`. Use it as the operating guide for when to choose Router, locator edits, patch edits, invariants, and workflow event recording.

## Automatic workflow events

Router v1 appends a workflow event automatically for each successful router call. Host-side safety blocks still do not reach Workbridge, so record the next successful event with `hostBlocks=1` when a block occurs.

## Registry log volume

`tool_registry_summary` is intentionally lightweight by default. Set `DEVSPACE_LOG_TOOL_REGISTRY_DETAIL=1` with debug logging only when full visible/hidden tool arrays are needed.


## Verification

Use `workbridge_verify` instead of ad-hoc `bash` for fixed verification profiles. The tool accepts only enum profiles and summarizes successful output. This keeps build/test stdout from flooding the chat and avoids combined shell-command safety blocks.

`workbridge_verify` uses spawn plus bounded tail capture. Successful stdout may be omitted by default, while failure/warning tails remain bounded.

`git_status_check` returns bounded output by default because the status text is the verification result. Other successful verify profiles omit stdout unless `includeOutputOnSuccess` is set.

Verify tool structured output is covered by schema smoke tests so optional fields such as `exitCode`, `signal`, `stdoutTail`, and `stderrTail` do not regress into MCP validation errors.

### Runtime version check

`workbridge_router` responses include `runtimeInfo` so MCP clients can confirm the active process version, commit, build source, process start time, entry path, and runtime dist path. After rebuilding or switching from `npx` to `node dist/cli.js serve`, verify `runtimeInfo.appVersion`, `runtimeInfo.gitCommit`, and `runtimeInfo.processStartedAt` before judging whether a new workflow behavior is present.
