# Configuration Reference

DevSpace can be configured through `devspace init`, persisted config files, or
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

DevSpace uses a single-user OAuth approval flow.

| Variable | Default |
| --- | --- |
| `DEVSPACE_OAUTH_ACCESS_TOKEN_TTL_SECONDS` | `3600` |
| `DEVSPACE_OAUTH_REFRESH_TOKEN_TTL_SECONDS` | `2592000` |
| `DEVSPACE_OAUTH_SCOPES` | `devspace` |
| `DEVSPACE_OAUTH_ALLOWED_REDIRECT_HOSTS` | `chatgpt.com,localhost,127.0.0.1` |

MCP clients discover metadata from:

```text
/.well-known/oauth-protected-resource/mcp
/.well-known/oauth-authorization-server
```

## Tool Modes

`DEVSPACE_TOOL_MODE` controls the tool surface.

| Value | Behavior |
| --- | --- |
| `minimal` | Default. Exposes `open_workspace`, `read`, `write`, `edit`, and `bash`. Clients use `bash` with tools such as `rg`, `find`, and `ls` for inspection. |
| `main` | Stable primary surface. Exposes the minimal tools plus dedicated `grep`, `glob`, and `ls` tools. |
| `full` | Exposes the minimal tools plus dedicated `grep`, `glob`, and `ls` tools. |
| `codex` | Experimental. Exposes `open_workspace`, `read`, `apply_patch`, `exec_command`, and `write_stdin`. Existing mutation and shell tools are hidden. |

`DEVSPACE_MINIMAL_TOOLS` remains a backward-compatible alias when
`DEVSPACE_TOOL_MODE` is unset: `1` selects `minimal` and `0` selects `full`.
The `codex` mode must be selected through `DEVSPACE_TOOL_MODE` and always uses
its fixed short tool names regardless of `DEVSPACE_TOOL_NAMING`.

Codex-mode commands run without a PTY by default. Set `tty: true` on
`exec_command` for interactive terminal programs. PTY support uses the optional
`node-pty` dependency; `write_stdin` can send input, poll output, and resize PTY
sessions.

### Patch consolidation guidance

This section is intentionally named so the guidance can be reverted cleanly if
it makes model behavior worse. Revert commit `feat guide patch consolidation`
or remove this section plus the matching `patchConsolidationInstruction` block
in `src/server.ts`.

In `codex` mode, related file edits should be batched into one `apply_patch`
call per logical implementation step. A single patch may update multiple files
and multiple hunks. Repeated small `apply_patch` calls should be avoided unless
the previous patch failed, the change set is too large to review safely, or the
user explicitly asks for separate checkpoints.

Set `WORKBRIDGE_ENABLE_WORKSPACE_TASKS=1` to expose `launch_workspace_task`.
The launcher accepts only allowlisted workspace tasks. The initial task is
`aegis_runner`, which resolves `aegis_runner.py` inside the opened workspace.
Templates may be defined in `.workbridge/workspace-tasks.json` or in a central
config file set with `WORKBRIDGE_WORKSPACE_TASKS_CONFIG`.

By default, `launch_workspace_task` requires a named template and does not
expose or accept arbitrary additional CLI arguments. Set
`WORKBRIDGE_ENABLE_WORKSPACE_TASK_DYNAMIC_ARGS=1` only when dynamic `args` are
intentionally required. With that opt-in enabled, template-less task launches
and additional CLI arguments use the legacy behavior.

## Widgets

`DEVSPACE_WIDGETS` controls ChatGPT Apps iframe usage.

| Value | Behavior |
| --- | --- |
| `full` | Default. Widget UI is attached to exposed workspace, file, edit, and shell tools. |
| `changes` | Enables the aggregate `show_changes` tool and attaches widget UI to `open_workspace` and `show_changes`. |
| `off` | Disables widget UI. |

## Skills

| Variable | Purpose |
| --- | --- |
| `DEVSPACE_SKILLS` | Set to `0` to hide skills. Enabled by default. |
| `DEVSPACE_SUBAGENTS` | Set to `1` to expose configured agent profiles as Subagents. Experimental and disabled by default. |
| `DEVSPACE_AGENT_DIR` | Defaults to `~/.codex`; its `skills` child is loaded for compatibility. |
| `DEVSPACE_SKILL_PATHS` | Optional comma-separated additional skill directories. |

DevSpace discovers standard Agent Skills from:

- `~/.agents/skills`
- project `.agents/skills`
- `~/.devspace/skills`

It also keeps compatibility with:

- the bundled `subagent-delegation` skill when `DEVSPACE_SUBAGENTS=1`, unless `~/.devspace/skills/subagent-delegation/SKILL.md` exists
- `DEVSPACE_AGENT_DIR/skills`, defaulting to `~/.codex/skills`
- additional paths from `DEVSPACE_SKILL_PATHS`

When Subagents are enabled, DevSpace discovers agent profiles
from:

- `~/.devspace/agents/*.md`
- project `.devspace/agents/*.md`

`open_workspace` returns a compact catalog containing profile names,
descriptions, providers, and optional models/thinking levels so the host model can choose an
agent without reading provider-specific launch details. `devspace agents ls`
lists existing subagent sessions for the current workspace, scoped by the
workspace environment injected into shell commands. The `subagent-delegation`
skill teaches the model to use only the minimal `devspace agents ls`,
`devspace agents run`, and `devspace agents show` workflow.

Starter profile templates are available under `examples/agents/`. Copy or adapt
them into one of the active profile directories before use.

Legacy project paths such as `.pi/skills` can be added through `DEVSPACE_SKILL_PATHS` when needed.

Example:

```bash
DEVSPACE_SKILL_PATHS="$HOME/.claude/skills,$HOME/company/skills" \
npx @waishnav/devspace serve
```

## Child process environment

Commands launched by `exec_command`, `bash`, and workspace tasks receive a
minimal environment containing the operating-system, shell, locale, temporary
directory, home-directory, and executable-search variables needed by common
Node, Python, and Git workflows.

Additional variables must be named explicitly in a comma-separated allowlist:

```bash
DEVSPACE_CHILD_ENV_ALLOWLIST="DISCORD_WEBHOOK_URL,CUSTOM_BUILD_FLAG"
```

`DEVSPACE_OAUTH_OWNER_TOKEN` and HTTP authorization variables are never passed
to child processes, even if named in the allowlist. The allowlist control
variable itself is also not passed to children.

For the current Aegis Gate integration, Windows discovery variables such as
`LOCALAPPDATA`, `ProgramFiles`, and `COMPUTERNAME` are included in the safe
baseline. Discord notifications require the webhook variable to be explicitly
allowed:

```bash
DEVSPACE_CHILD_ENV_ALLOWLIST="AEGIS_GATE_DISCORD_WEBHOOK_URL"
```

Add `AEGIS_GATE_LLM_API_KEY` only when Aegis Gate cycle summaries are configured
with both `enabled=true` and `use_llm=true`.

## Logging

| Variable | Default |
| --- | --- |
| `DEVSPACE_LOG_LEVEL` | `info` |
| `DEVSPACE_LOG_FORMAT` | `json` |
| `DEVSPACE_LOG_FILE` | `1` |
| `DEVSPACE_LOG_FILE_PATH` | `<stateDir>/logs/devspace.jsonl` |
| `DEVSPACE_LOG_FILE_MAX_BYTES` | `10485760` |
| `DEVSPACE_LOG_FILE_MAX_FILES` | `5` |
| `DEVSPACE_LOG_CONSOLE_JSON` | `0` |
| `DEVSPACE_LOG_REQUESTS` | `1` |
| `DEVSPACE_LOG_ASSETS` | `0` |
| `DEVSPACE_LOG_TOOL_CALLS` | `1` |
| `DEVSPACE_LOG_SHELL_COMMANDS` | `0` |
| `DEVSPACE_TRUST_PROXY` | `0` |
| `WORKBRIDGE_EXPERIMENTAL_FEATURES` | unset |

Set `DEVSPACE_LOG_FORMAT=pretty` for local debugging when
`DEVSPACE_LOG_CONSOLE_JSON=1`.

Logs are written as JSONL by default to `DEVSPACE_LOG_FILE_PATH`. Console output
is intentionally compact and uses this fixed-column format:

`DEVSPACE_LOG_FILE_MAX_BYTES` rotates the JSONL file before a write would exceed
the configured size. Set it to `0` to disable rotation. Rotated files are kept as
`.1`, `.2`, and so on up to `DEVSPACE_LOG_FILE_MAX_FILES - 1`.
`time | workspace/ip | kind | tool | status | duration | details`.

Tool calls are shown in compact form. HTTP requests are shown in compact form
when the path is `/mcp`, the status is `400` or higher, or the request takes at
least 1000ms. HTTP request rows use the workspace column for the request IP when
no workspace id is available. Other JSON events remain in the JSONL file and are
hidden from the console unless `DEVSPACE_LOG_CONSOLE_JSON=1` is set.

Set `WORKBRIDGE_EXPERIMENTAL_FEATURES=command_metadata` to add optional
self-reported metadata fields to `exec_command`. When enabled, `intent` and
`retryContext` are included in the tool schema and written to JSONL tool-call
logs when the model supplies them. These fields are not shown in the compact
console and should be treated as model self-reporting, not observed host-side
safety-check counts. `DEVSPACE_EXPERIMENTAL_FEATURES` is accepted as a legacy
alias.

Normal HTTP request lines are highlighted cyan when the terminal supports ANSI
colors. Second-level durations are highlighted yellow, while failed tool lines
and HTTP `4xx`/`5xx` lines are highlighted red. Set `NO_COLOR=1` to disable
colors.

## Env-Only Example

```bash
DEVSPACE_OAUTH_OWNER_TOKEN="$(openssl rand -base64 32)" \
DEVSPACE_ALLOWED_ROOTS="$HOME/personal,$HOME/work" \
DEVSPACE_PUBLIC_BASE_URL="https://devspace.example.com" \
DEVSPACE_WORKTREE_ROOT="$HOME/.devspace/worktrees" \
DEVSPACE_TOOL_MODE="minimal" \
DEVSPACE_WIDGETS="full" \
npx @waishnav/devspace serve
```

The environment assignments must be part of the same command invocation, or
exported first.
