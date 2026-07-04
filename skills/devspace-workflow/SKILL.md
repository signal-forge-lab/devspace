# DevSpace Workflow

Use this skill when working in DevSpace on implementation, review, verification, ZIP-first experiments, or Router experiments.


## Unified operating policy

Use `docs/devspace-operating-policy.md` as the canonical policy for task classes, reference-vs-secret handling, structured transport, verification routing, and incident-to-improvement behavior. This skill should stay short and point to that policy instead of duplicating project-specific playbooks.

## Core rule

Keep ChatGPT-to-DevSpace requests small. Prefer structured actions, refs, locators, hashes, and limits over broad shell commands or large text payloads.

## Preferred workflow

1. Start with `devspace_router` when the task can be expressed with `action`, `workflowMode`, `targets`, `refs`, and `limits`.
2. Use `resolve_locator` before editing when exact text replacement or fixed line ranges may be unstable.
3. Use `apply_structured_edit` for locator-based edits.
4. Use `apply_unified_patch` for ZIP-first or multi-line code/doc changes. Always run `dryRun` first and provide `expectedBase` sha256 values.
5. Use `check_workspace_invariants` after cross-file updates, version bumps, import rewrites, or config/schema changes.
6. Use `record_workflow_event` to record workflow experiments, especially host blocks or fallback steps that DevSpace cannot observe directly.

When a classifier result is available, follow its `recommendedSequence` and `requiredChecks`. Higher `risk` means choose a more structured path; it does not mean skip the work.

For `large_edit_refactor`, review alternate execution path candidates before broad edits. Categories include fallback, manual injection, CLI, batch/script, daemon/runtime, popup/UI, config, test, and generated artifact paths.

Use verification policy output from Router `verify_plan` to select fixed `devspace_verify` profiles. Keep validation minimal but sufficient for the task class; do not add live external smoke unless explicitly approved.

## Workflow modes

Use one of these modes consistently per task:

- `baseline`: existing individual-tool workflow.
- `zip_first`: ZIP-first workflow without Router control.
- `router`: Router workflow without ZIP-first assumptions.
- `zip_first_router`: combined ZIP-first + Router experiment.

## Avoid fixed endLine edits

Do not edit small or changing files with broad fixed ranges such as `startLine=1,endLine=200` unless the current line count was just confirmed.

For files such as `queue/next_task.md`, prefer:

- `devspace_router action=inspect`
- `resolve_locator` with `section_heading`, `anchor`, or `between_anchors`
- `apply_structured_edit` using the resolved locator

If `edit_by_line_range` reports `endLine exceeds file length`, retry with the actual file length or switch to a locator-based edit.

## Avoid heredoc and large shell writes

Do not use long bash heredocs or embedded Python triple-quoted strings to generate large files. These often fail with quote, EOF, or host safety errors.

Prefer:

- ZIP-first inspection followed by `apply_unified_patch`
- small locator edits with `apply_structured_edit`
- small, focused commands for verification only

`apply_structured_edit` and `apply_unified_patch` may use `contentEncoding="plain"` or `"base64"`. Base64 is typed transport for preserving special characters or larger templates. It is not a bypass mechanism and must not carry real secret values.

## Sensitive integration

For env/API/webhook/token work, separate references from values:

- env var names and config keys are allowed as typed references.
- `secretValueHandling` should be `never_read_or_write` or `mock_only`.
- live secret values, cookies, sessions, Authorization header values, and live tokens must not be read, written, logged, or transported.
- default to config-only or mock-first tests unless live smoke is explicitly approved.

## Incident loop

Treat incidents as route-improvement input. Do not repeatedly retry the same blocked or brittle shape. Map failures to actions such as structured schema, structured edit transport, locator resolution, bounded report/tail output, alternate path detection, or explicit live-smoke gating. Use `logs:report` to inspect efficiency metrics and improvement hints.

## Router v0 usage

Router v0 is read-only/planning oriented. It should not receive shell commands, patches, full file contents, or full `newContent` payloads.

Good Router inputs:

- `action`
- `workflowMode`
- `targets.paths`
- `refs`
- `limits`
- short `intent`

Bad Router inputs:

- long file bodies
- huge diffs
- arbitrary bash commands
- commit instructions
- combined commands such as `npm test && npm run build && git diff --check`

## Invariant checks

Use `check_workspace_invariants` for generic consistency checks, not project-specific scripts.

Examples:

- old token absent after rename
- new token present in expected files
- JSON values equal across package files
- regex count within expected range

## Host block recording

OpenAI host-side safety blocks do not reach DevSpace logs. After a blocked action, record the next successful workflow event with `hostBlocks=1` and a short note.

Example event fields:

- `workflowMode`
- `event`
- `action`
- `tool`
- `status`
- `hostBlocks`
- `note`

## Output limits

Keep outputs bounded. Prefer summaries, counts, hashes, and short previews. Avoid returning full test/build output unless failure details are needed.


## Verification

Prefer `devspace_verify` over ad-hoc `bash` for fixed verification work. It accepts enum profiles instead of arbitrary shell commands and returns bounded output.

Use these profiles when appropriate:

- `typecheck_only` for TypeScript typecheck.
- `related_tests` for workflow/safe-editing focused tests.
- `workflow_tools_test` for workflow primitives.
- `safe_editing_test` for safe editing behavior.
- `npm_test` for the full test suite.
- `build` for package build.
- `git_diff_check` for working tree whitespace/diff checks.
- `git_diff_cached_check` for staged whitespace/diff checks.
- `git_status_check` for bounded short status output. Unlike most successful verify profiles, it returns a bounded status tail by default because the status output is the purpose of the check.

Do not replace `devspace_verify` with combined shell commands such as `npm test && npm run build && git diff --check`. Run separate verify profiles so output remains bounded and failures are attributable.

`devspace_verify` separates `outputOmitted` from `outputTruncated`: omitted means successful output was intentionally not returned; truncated means a returned tail was shorter than the actual output.

`devspace_verify` has a timeout guard: it sends SIGTERM first and then a stronger kill signal after a short grace period if the child process has not closed.

## Router verification planning

Use `devspace_router action=verify_plan` or `suggest_verify` when you need a small, structured recommendation for which fixed `devspace_verify` profiles to run next. The router only suggests enum profiles; it must not execute arbitrary validation commands or accept shell command payloads.
