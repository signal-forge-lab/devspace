# Configuration Reference

## Workbridge display name

Workbridge is the public display name for this MCP connector. The legacy DevSpace name remains in package names, `DEVSPACE_*` environment variables, OAuth scope `devspace`, and compatibility paths until aliases are introduced. MCP clients should call `workbridge_guide` first when they need usage instructions.

## Host-side Filter Recording

`record_tool_event` is intentionally minimum-first. When a host-side safety check
filters a tool call before Workbridge receives it, call `record_tool_event` with
only `toolName`, `operation`, and `category`, then switch to one safer tool
shape. Do not include `commandShape` or `note` in normal workflow.

## ZIP-first Read Rule

Use `export_workspace_zip` plus `create_zip_download_url` before broad
repository reading/searching. This is mandatory when a task may require reading
3 or more files, inspecting large files, searching across the repository,
inspecting SDK/node_modules/generated/docs across multiple paths, preparing to
use repeated MCP reads/searches, or after a host-side read/search filter event. Before
ZIP transfer, use at most 1 `workspace_snapshot`, 1 `file_outline`, and 1
focused `read_index_ranges`.

`create_workspace_index` is idempotent by default. Repeated calls with the same
workspace, filters, tracked file set, file sizes, and mtimes reuse the existing
index and return a lightweight cache-hit response. Set `includePreview=true` to
show preview entries on cache hits, or `refresh=true` to force a new index.
Both `grep_context` and `file_outline` accept `indexId` plus optional `numbers`
to operate on the indexed file set without adding separate index-specific tools.

ZIP snapshots are read-only context. All writes must still go through MCP
workspace tools and should live re-read or hash-check target ranges before
editing.

## ZIP File Import Probe

`DEVSPACE_ENABLE_WORKFLOW_TOOLS=1` exposes workflow primitives for ZIP-first and router experiments: `workbridge_router`, `workbridge_verify`, `apply_unified_patch`, `resolve_locator`, `apply_structured_edit`, `check_workspace_invariants`, and `record_workflow_event`. `workbridge_verify` provides fixed profiles including `typecheck_only`, `related_tests`, `npm_test`, `build`, `git_diff_check`, `git_diff_cached_check`, and `git_status_check`. These tools are opt-in so stable ChatGPT tool lists stay small. See `docs/workflow-router.md` and `skills/workbridge-workflow/SKILL.md` for Router v0 usage rules. Router calls automatically append workflow events under `.devspace/workflow-events/events.jsonl`.

`DEVSPACE_LOG_TOOL_REGISTRY_DETAIL=1` enables full registry detail logging at debug level. By default, `tool_registry_summary` logs only counts, enabled profiles, feature flags, and a registry hash to reduce per-session log volume.

`import_zip_from_url` and `extract_imported_zip` perform normal URL-based ZIP import. `import_zip_from_url` accepts non-URL strings only for host rewrite diagnostics; Workbridge still imports only `http(s)` sources. Optional `probe_import_file_arg_shape`, `probe_import_file`, and legacy `import_zip_file` validate the
ChatGPT-to-Workbridge direction using a top-level MCP file parameter. This is the
only supported reverse-transfer path. Upload URLs and base64/chunk transfer are
not part of this workflow. Imported ZIP files are isolated under
`.devspace/imports/<importId>`, saved as `source.zip`, accompanied by
`import.json` metadata, and are never extracted directly into the live workspace
root.

Workbridge can be configured through `workbridge init`, persisted config files, or
environment variables.

The default files are:

```text
~/.devspace/config.json
~/.devspace/auth.json
```

Use another config directory with:

```bash
DEVSPACE_CONFIG_DIR=/path/to/config npx @waishnav/devspace serve
```

## Commands

```bash
npx @waishnav/devspace init
npx @waishnav/devspace serve
npx @waishnav/devspace doctor
npx @waishnav/devspace config get
npx @waishnav/devspace config set publicBaseUrl https://devspace.example.com
```

## Core Environment Variables

| Variable | Purpose |
| --- | --- |
| `HOST` | Local bind host. Defaults to `127.0.0.1`. |
| `PORT` | Local port. Defaults to `7676`. |
| `DEVSPACE_ALLOWED_ROOTS` | Comma-separated local roots that workspaces may open. |
| `DEVSPACE_PUBLIC_BASE_URL` | Public origin for the server, without `/mcp`. |
| `DEVSPACE_ALLOWED_HOSTS` | Optional Host header allowlist override. |
| `DEVSPACE_OAUTH_OWNER_TOKEN` | Owner password for OAuth approval. Must be at least 16 characters. |
| `DEVSPACE_WORKTREE_ROOT` | Directory for managed Git worktrees. Defaults to `~/.devspace/worktrees`. |
| `DEVSPACE_STATE_DIR` | Directory for SQLite state. Defaults to `~/.local/share/devspace`. |

## OAuth

Workbridge uses a single-user OAuth approval flow.

| Variable | Default |
| --- | --- |
| `DEVSPACE_OAUTH_ACCESS_TOKEN_TTL_SECONDS` | `3600` |
| `DEVSPACE_OAUTH_REFRESH_TOKEN_TTL_SECONDS` | `2592000` |
| `DEVSPACE_OAUTH_SCOPES` | `devspace` |
| `DEVSPACE_TRUST_PROXY` | unset / disabled. Set to `1` when Workbridge runs behind one local tunnel or reverse proxy hop. Express is configured with trust proxy hop count `1`, not permissive `true`. |
| `DEVSPACE_OAUTH_ALLOWED_REDIRECT_HOSTS` | `chatgpt.com,claude.ai,anthropic.com,localhost,127.0.0.1` |
| `DEVSPACE_OAUTH_STATIC_CLIENTS_JSON` | unset |
| `DEVSPACE_OAUTH_SAFE_DIAGNOSTIC_LOGGING` | `true` |

`DEVSPACE_OAUTH_STATIC_CLIENTS_JSON` registers fixed public OAuth clients. This is useful for web MCP clients that cannot use dynamic client registration reliably or that ask for an explicit OAuth Client ID.

Example:

```json
[
  {
    "clientId": "claude-web-workbridge",
    "clientName": "Claude Web Workbridge",
    "redirectUris": ["https://claude.ai/api/mcp/auth_callback"],
    "allowedScopes": ["devspace"]
  }
]
```

If the web client does not show its callback URL, temporarily set `redirectUris` to an empty array and try the connection. Workbridge will reject the authorization request, but safe OAuth diagnostics will log the requested `redirect_uri` without logging authorization codes, access tokens, refresh tokens, client secrets, cookies, or authorization headers. Add the observed URI to the static client allowlist and restart Workbridge.

MCP clients discover metadata from:

```text
/.well-known/oauth-protected-resource/mcp
/.well-known/oauth-authorization-server
```

## Workbridge Tool Modes

`DEVSPACE_TOOL_MODE` controls the Workbridge MCP tool surface. Tool names are short-only.
Legacy direct read and multi-edit tools stay hidden unless enabled by their
dedicated feature flags. Workbridge uses `DEVSPACE_*` names for compatibility with the upstream Workbridge package.

| Value | Behavior |
| --- | --- |
| `minimal` | Default Workbridge profile. Exposes core workspace, bounded Workbridge inspection, targeted edit, git status/commit, and shell tools; hides advanced edit/git helpers plus dedicated `grep`, `glob`, and `ls`. |
| `full` | Enables the advanced Workbridge edit/git helpers plus dedicated `grep`, `glob`, and `ls` tools. |
| `main` | Main-only profile. Exposes upstream-style main tools only: `open_workspace`, `read`, `write`, `edit`, `bash`, `grep`, `glob`, and `ls`. Fork-origin Workbridge helpers remain hidden. |
| `codex` | Main + main/codex profile. Exposes main tools plus `apply_patch`, `exec_command`, and `write_stdin`. Fork-origin Workbridge helpers remain hidden. |

`DEVSPACE_MINIMAL_TOOLS` remains a backward-compatible alias when
`DEVSPACE_TOOL_MODE` is unset: `1` selects `minimal` and `0` selects `full`.


### Tool selection notes

- `apply_patch` uses Codex patch format and is best for add/update/delete/move operations in `codex` mode.
- `apply_unified_patch` is a Workbridge workflow tool for hash-guarded unified diffs with `expectedBase` / sha256 checks. It is available only when fork-origin workflow tools are enabled in a Workbridge mode.
- `bash` is the bounded command tool for `minimal` / `full` / `main` / `codex` modes.
- `exec_command` and `write_stdin` are process-session tools for `codex` mode, or when process tools are explicitly enabled.
- `launch_workspace_task` is an opt-in Workbridge task launcher for allowlisted local workspace tasks. It accepts a task name plus either free-form `args` or a named template, without accepting a raw shell command string. The initial allowlisted task is `aegis_runner`; templates are `status_console_5s`, `daemon_confirm_post`, `daemon_confirm_post_bounded_10m`, `request_pause`, and `resume_daemon`.

- `run_codex_cli` is a local Codex CLI wrapper and is separate from `DEVSPACE_TOOL_MODE=codex`.

`open_workspace` returns a compact workspace guidance bundle so clients do not need to rediscover every tool schema before choosing a workflow. The structured response includes `toolSurface`, `recommendedWorkflow`, `workspaceTasks`, `verificationProfiles`, and `strategies` for edit, command, and git operations. Treat this as the first routing hint for the workspace; in main-only modes use the returned tool surface instead of fork-origin inspection helpers.
Codex-mode commands run without a PTY by default. Set `tty: true` on
`exec_command` for interactive terminal programs. PTY support uses the optional
`node-pty` dependency; `write_stdin` can send input, poll output, and resize PTY
sessions.

Recommended optional shell helpers for minimal mode:

| Tool | Primary use |
| --- | --- |
| `rg` or `grep` | Text search. Prefer `rg` when installed; use `grep` as the portable fallback. |
| `fd` or `find` | File discovery. Prefer `fd` when installed; use `find` as the portable fallback. |
| `ls` or `tree` | Directory inspection. |
| `jq` | JSON inspection, including `package.json` and JSONL log summaries. |
| `yq` | YAML inspection, including Cloudflare Tunnel and GitHub Actions config files. |

Shell helpers must be available on the PATH of the shell that starts Workbridge.
After installing a helper, restart the terminal and then restart `workbridge serve`.

Optional tool flags keep the default schema surface small:

| Variable | Default | Behavior |
| --- | --- | --- |
| `DEVSPACE_ENABLE_WORKFLOW_TOOLS` | `0` | Enables workflow tools such as `workbridge_router`, `workbridge_verify`, structured patch/edit helpers, and workflow event recording. |
| `DEVSPACE_ENABLE_LEGACY_READ_TOOLS` | `0` | Enables `read_many` and other legacy direct read helpers where still supported. |
| `DEVSPACE_ENABLE_EDIT_MANY` | `0` | Enables `edit_many`. |
| `DEVSPACE_ENABLE_ZIP_EXPORT_TOOLS` | `0` | Enables ZIP export/download tools. |
| `DEVSPACE_ENABLE_ZIP_IMPORT_TOOLS` | `0` | Enables ZIP import tools. |
| `DEVSPACE_ENABLE_CODEX_CLI` | `0` | Enables the local Codex CLI wrapper tool. |
| `DEVSPACE_ENABLE_TASK_TOOLS` | `0` | Enables task checkpoint/resume helpers. |
| `WORKBRIDGE_ENABLE_WORKSPACE_TASKS` / `DEVSPACE_ENABLE_WORKSPACE_TASKS` | `0` | Enables `launch_workspace_task` for allowlisted local workspace task entrypoints. Initially supports `aegis_runner` with dynamic `args` and templates loaded from config files. |

When workspace tasks are enabled, Workbridge can read templates from two external config locations.
First, it reads one optional central template config at startup: by default `.workbridge/workspace-tasks.json` relative to the directory where Workbridge is started, or the file named by `WORKBRIDGE_WORKSPACE_TASKS_CONFIG` / `DEVSPACE_WORKSPACE_TASKS_CONFIG`.
Second, it reads optional workspace-local templates from `<opened workspace>/.workbridge/workspace-tasks.json` when a workspace task catalog or task launch is resolved.
Workbridge does not keep built-in named workspace task templates in code.
Config files may define templates for allowlisted tasks, but cannot add new task entrypoints, runtimes, or scripts. Workspace-local templates may add project-specific names, but cannot override templates already defined by the central config.

```json
{
  "tasks": {
    "aegis_runner": {
      "templates": {
        "custom_status": {
          "args": ["--status"],
          "description": "Run a workspace-defined status check."
        }
      }
    }
  }
}
```

Invalid configured templates are ignored and reported in `open_workspace` under `workspaceTasks.tasks[].templateConfig.issues`.


At startup Workbridge logs a compact `tool_registry_summary` event containing exposed tool names, hidden tool names, enabled profiles, and feature flag state. Prefer that local log event over repeated schema discovery when checking whether optional tools are hidden.

## Widgets

`DEVSPACE_WIDGETS` controls ChatGPT Apps iframe usage.

| Value | Behavior |
| --- | --- |
| `full` | Widget UI is attached to exposed workspace, file, edit, and shell tools. |
| `changes` | Enables the aggregate `show_changes` tool and attaches widget UI to `open_workspace` and `show_changes`. |
| `off` | Default. Disables widget UI. |

## Skills

| Variable | Purpose |
| --- | --- |
| `DEVSPACE_SKILLS` | Set to `0` to hide skills. Enabled by default. |
| `DEVSPACE_AGENT_DIR` | Defaults to `~/.codex`; its `skills` child is loaded for compatibility. |
| `DEVSPACE_SKILL_PATHS` | Optional comma-separated additional skill directories. |

Workbridge discovers standard Agent Skills from:

- `~/.agents/skills`
- project `.agents/skills`

It also keeps compatibility with:

- `DEVSPACE_AGENT_DIR/skills`, defaulting to `~/.codex/skills`
- additional paths from `DEVSPACE_SKILL_PATHS`

Legacy project paths such as `.pi/skills` can be added through `DEVSPACE_SKILL_PATHS` when needed.

Example:

```bash
DEVSPACE_SKILL_PATHS="$HOME/.claude/skills,$HOME/company/skills" \
npx @waishnav/devspace serve
```

## Logging

| Variable | Default |
| --- | --- |
| `DEVSPACE_LOG_LEVEL` | `info` |
| `DEVSPACE_LOG_FORMAT` | `json` |
| `DEVSPACE_CONSOLE_LOG_LEVEL` | `warn` when file logging is enabled; `info` when disabled |
| `DEVSPACE_LOG_REQUESTS` | `1` |
| `DEVSPACE_LOG_ASSETS` | `0` |
| `DEVSPACE_LOG_TOOL_CALLS` | `1` |
| `DEVSPACE_LOG_SHELL_COMMANDS` | `0` |
| `DEVSPACE_LOG_FILE` | `1` |
| `DEVSPACE_LOG_DIR` | `logs` |
| `DEVSPACE_LOG_FILE_NAME` | `devspace_YYYYMMDD_HHMMSS.jsonl` |
| `DEVSPACE_TRUST_PROXY` | `0` |

By default, Workbridge writes detailed JSONL logs directly to `logs/` and keeps stdout concise.
Informational events stay in the local log file, while the console defaults to warnings,
errors, and compact summaries for important execution-style tool calls.
Set `DEVSPACE_CONSOLE_LOG_LEVEL=info` for verbose console logging, `DEVSPACE_LOG_FILE=0`
to disable file logging, `DEVSPACE_LOG_DIR` to change the output directory, or
`DEVSPACE_LOG_FILE_NAME` to force a specific filename.

Set `DEVSPACE_LOG_FORMAT=pretty` for local debugging. File logs remain JSONL so
the analyzer can read them consistently.

Set `DEVSPACE_LOG_SHELL_COMMANDS=1` only when you intentionally want command
previews in logs.

To analyze saved JSONL logs and generate a local dashboard, see
[Log Analysis](./log-analysis.md).

## Env-Only Example

```bash
DEVSPACE_OAUTH_OWNER_TOKEN="$(openssl rand -base64 32)" \
DEVSPACE_ALLOWED_ROOTS="$HOME/personal,$HOME/work" \
DEVSPACE_PUBLIC_BASE_URL="https://devspace.example.com" \
DEVSPACE_WORKTREE_ROOT="$HOME/.devspace/worktrees" \
DEVSPACE_TOOL_MODE="minimal" \
DEVSPACE_WIDGETS="off" \
npx @waishnav/devspace serve
```

The environment assignments must be part of the same command invocation, or
exported first.

`workbridge_verify` preflight behavior: `git_status_check` returns bounded status output by default, while long-running commands use a timeout guard with SIGTERM followed by a stronger kill signal after a short grace period. <!-- 1.1.27 preflight -->

`workbridge_verify` profile names are maintained from a single `WORKBRIDGE_VERIFY_PROFILES` source and covered by schema smoke tests to reduce MCP structured-output validation regressions.

On Windows, package-manager verify profiles (`typecheck_only`, `related_tests`, `workflow_tools_test`, `safe_editing_test`, `npm_test`, and `build`) are launched through a fixed shell command string because direct `spawn("npm.cmd")` / `spawn("npx.cmd")` can fail with `EINVAL` in the Git Bash-backed runtime. These are still fixed enum profiles, not arbitrary shell commands. <!-- package-manager verify profiles -->

## Auto efficiency ledger

Workbridge writes sanitized tool-efficiency events to `.devspace/efficiency/events.jsonl` by default. The ledger is intended for after-action reviews such as bash usage, failed tool calls, output truncation, structured-tool usage, and verification coverage.

| Variable | Default | Description |
| --- | --- | --- |
| `WORKBRIDGE_EFFICIENCY_LEDGER` / `DEVSPACE_EFFICIENCY_LEDGER` | `1` | Set to `0`, `false`, `off`, or `no` to disable efficiency event writes. |
| `WORKBRIDGE_EFFICIENCY_LEDGER_PATH` / `DEVSPACE_EFFICIENCY_LEDGER_PATH` | `.devspace/efficiency/events.jsonl` | Override the efficiency ledger JSONL path. |

Use `workbridge_efficiency_report` from MCP clients or `npm run efficiency:report` locally to summarize the ledger.
