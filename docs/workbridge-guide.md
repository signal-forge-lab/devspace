# Workbridge Guide

Workbridge is the public display name for this MCP connector. DevSpace remains the legacy internal name in package names, `DEVSPACE_*` environment variables, OAuth scope names, and some historical tool names.

## What Workbridge does

Workbridge connects AI clients such as ChatGPT or Claude to allowed local workspaces for safe inspection, editing, verification, git status checks, and commits.

## First steps for MCP clients

1. Call `workbridge_guide` when the connector is unfamiliar.
2. Call `open_workspace` once for the target project path and reuse the returned `workspaceId`.
3. Follow AGENTS.md, nested instruction files, and relevant skill files reported by `open_workspace`.
4. Start with bounded inspection: `workspace_snapshot`, `grep_context`, `file_outline`, `create_workspace_index`, or `read_index_ranges`.
5. Make targeted edits and verify with fixed profiles such as `devspace_verify` before reporting completion.

The `open_workspace` structured response includes workspace routing hints: `toolSurface`, `recommendedWorkflow`, `workspaceTasks`, `verificationProfiles`, and edit/command/git `strategies`. Use these hints before searching the tool registry again.

## Tool modes

| Mode | Purpose | Typical tools |
| --- | --- | --- |
| `minimal` | Default Workbridge mode. Compact, safe surface for normal ChatGPT/Claude work. | `workspace_snapshot`, `grep_context`, `file_outline`, `read_index_ranges`, `edit`, `edit_by_line_range`, `bash`, `git_*`, `workbridge_efficiency_report` |
| `full` | Advanced Workbridge mode for local/power-user sessions. | Adds `grep`, `glob`, `ls`, `write`, advanced edit/git helpers |
| `codex` | Codex-compatible mode plus Workbridge guide/diagnostics/bounded workflow helpers. | `read`, `apply_patch`, `exec_command`, `write_stdin`, plus Workbridge guide/inspection/efficiency helpers |

Use `DEVSPACE_TOOL_MODE=codex` when you want the upstream Codex-style tool surface. This is different from `run_codex_cli`, which launches a local Codex CLI wrapper from Workbridge.

## Patch tool selection

| Tool | Patch format | Use when |
| --- | --- | --- |
| `apply_patch` | Codex patch format with `*** Begin Patch` / `*** End Patch` | A Codex-style patch is already provided, or you need add/update/delete/move support in codex mode. |
| `apply_unified_patch` | Unified diff with `expectedBase` / sha256 guards | You need hash-guarded file safety and explicit base verification. |
| `apply_structured_edit` / `edit_by_line_range` | Locator or line-range based edits | You have inspected exact targets and want bounded targeted edits. |

Do not use shell redirection, `tee`, `sed -i`, or ad-hoc scripts for project file mutation when a Workbridge editing tool fits.

## Process and verification tool selection

| Tool | Use when |
| --- | --- |
| `devspace_verify` | Fixed verification profiles such as git status/diff, typecheck, tests, and build. Prefer this over ad-hoc shell when a profile fits. |
| `launch_workspace_task` | Opt-in launcher for allowlisted local workspace tasks without accepting raw shell command strings. Initially supports `aegis_runner` with dynamic `args` or named templates. |

| `bash` | Bounded minimal/full-mode tests, builds, and inspection commands. Keep output small and avoid file mutation through shell. |
| `exec_command` | Codex-mode process session command for long-running, interactive, PTY, polling, or Ctrl-C workflows. |
| `write_stdin` | Follow-up tool for an `exec_command` session. Use it to poll, send input, resize PTY, or interrupt. |

Enable workspace tasks with `WORKBRIDGE_ENABLE_WORKSPACE_TASKS=1` or the legacy-compatible `DEVSPACE_ENABLE_WORKSPACE_TASKS=1`. Example payloads:

```json
{"task":"aegis_runner","template":"status_console_5s","tty":true,"yieldTimeMs":1000}
```

```json
{"task":"aegis_runner","args":["--launch-status-console","--status-console-refresh-seconds","5"],"tty":true,"yieldTimeMs":1000}
```

Available `aegis_runner` templates:

| Template | Args |
| --- | --- |
| `status_console_5s` | `--launch-status-console --status-console-refresh-seconds 5` |
| `daemon_confirm_post` | `--daemon --confirm-post` |
| `daemon_confirm_post_bounded_10m` | `--daemon --confirm-post --daemon-max-runtime-seconds 600 --daemon-poll-seconds 10 --daemon-heartbeat-seconds 10` |
| `request_pause` | `--request-pause` |
| `resume_daemon` | `--resume-daemon` |

For normal Aegis startup with a status console, launch two tasks instead of mixing both modes into one template:

```text
1. launch_workspace_task template=status_console_5s
2. launch_workspace_task template=daemon_confirm_post
```

## Router guidance

Use `devspace_router` when tool choice is unclear. It is especially useful for:

- choosing `apply_patch` vs `apply_unified_patch` vs structured edits,
- creating verification plans with `devspace_verify`,
- identifying alternate execution paths for large refactors,
- keeping workflow output bounded.

## Safety rules

- Do not read or print secrets, tokens, cookies, session files, private keys, or live credentials.
- Do not perform external side effects, notifications, posting, deploys, or destructive git operations unless explicitly requested.
- Do not use broad shell commands to modify project files; prefer Workbridge editing tools.
- If a host/client safety filter blocks a request, do not repeat the same command shape.

## Efficiency ledger

Workbridge records a sanitized auto efficiency ledger at `.devspace/efficiency/events.jsonl` by default. It captures tool call counts, failures, bash/process usage, read batching, verification usage, patch usage, output volume, and host/client filter events without recording shell command bodies or secrets.

Use `workbridge_efficiency_report` from an MCP client, or run:

```bash
npm run efficiency:report
```

Set `WORKBRIDGE_EFFICIENCY_LEDGER=0` or `DEVSPACE_EFFICIENCY_LEDGER=0` to disable the ledger. Set `WORKBRIDGE_EFFICIENCY_LEDGER_PATH` to change the file path.

## Naming transition

Use **Workbridge** in user-facing names and connector descriptions. Keep `DEVSPACE_*`, `devspace_*`, and package names until compatibility aliases are implemented.
