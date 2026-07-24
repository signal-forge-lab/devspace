# Configuration Reference

Workbridge uses a fixed MCP contract. The upstream tool modes, widget modes,
and subagent implementations remain in the codebase for upstream compatibility,
but the Workbridge runtime selects its fixed profile rather than exposing them
as runtime options.

The default persisted files are:

```text
~/.devspace/config.json
~/.devspace/auth.json
```

Use another config directory with:

```bash
DEVSPACE_CONFIG_DIR=/path/to/config npx @waishnav/devspace serve
```

## Fixed Tool Surface

Every server instance exposes exactly these tools:

```text
open_workspace
read
apply_patch
exec_command
write_stdin
run_workspace_action
download_artifact
```

Changing environment variables does not add, remove, or reshape these tools.
Command metadata fields are always present on `exec_command`. Skills are always
enabled. Widget metadata, `show_changes`, and subagent catalog fields are not
exposed by the Workbridge profile. `download_artifact` remains visible on every
platform; Linux executes it, while unsupported platforms return a clear error.

## Workspace Actions

`run_workspace_action` is the stable gateway for repeatable Workbridge-owned
operations. The MCP input contract stays stable while actions are added to the
internal Action Registry.

Inputs:

```text
workspaceId
action
preset?
parameters?
dryRun?
workingDirectory?
tty?
columns?
rows?
yieldTimeMs?
maxOutputTokens?
```

Workbridge resolves the action and preset, validates structured parameters,
applies the action policy, and chooses the concrete command. Arbitrary CLI
arguments are not forwarded from `parameters`.

The built-in actions are:

```text
action: workspace_verify
preset: standard

action: workspace_review
preset: summary | integrity

action: project_verify
preset: quick | standard

action: test_changed
preset: exact
```

It runs this fixed fail-fast sequence:

```text
npm run typecheck
npm run baseline:tools:check
npm test
npm run build
git diff --check
git status --short
```

`workspace_review` is read-only. Its `summary` preset reports concise Git status
plus staged and unstaged diff statistics. Its `integrity` preset runs
`git diff --check` and then reports concise Git status.

`workspace_verify/standard` is retained as a 1.x compatibility action. It is
resolved through `project_verify/standard` with the built-in `workbridge`
profile, so the verification sequence has one implementation. New workflows
should call `project_verify` directly.

`project_verify` selects a built-in project profile and resolves a fixed command.
The first built-in profiles are:

```text
workbridge
  exact match: package name @waishnav/devspace plus src/workspace-actions.ts
  command: the Workbridge-specific verification sequence

chrome_extension
  strong match: valid manifest.json in the workspace root
  command: manifest/resource validation plus supported package scripts

python
  strong match: pyproject.toml, pytest.ini, setup.cfg, or requirements.txt
  command: configured Python checks through uv, Poetry, or system Python

node
  strong match: package.json in the workspace root
  command: available typecheck, lint, test, and build scripts in that order
```

Automatic detection prefers the exact `workbridge` profile, then
`chrome_extension`. A workspace with both Python and Node markers is rejected
as ambiguous until `parameters.profile` selects one; otherwise Python is chosen
before the generic `node` profile. The Chrome extension
profile validates manifest version 2 or 3 and verifies directly referenced
background, content-script, popup, options, icon, side-panel, DevTools, and
URL-override files before executing package scripts. To select a profile explicitly, pass
`parameters: { "profile": "workbridge" }`,
`parameters: { "profile": "chrome_extension" }`, or
`parameters: { "profile": "python" }`, or
`parameters: { "profile": "node" }`.
No external profile or action configuration files are loaded.

`project_verify/quick` omits build steps and, for Workbridge, also omits the full
test suite. `project_verify/standard` remains the default complete verification.
Actions are stored internally as ordered step plans. Starting in 1.1, the action
process runtime executes those steps sequentially inside one Workbridge session
and records completion, failure, cancellation, and skipped follow-up steps.
Each step emits concise start and finish markers around its ordinary process
output, for example `==> [typecheck] TypeScript typecheck` and
`<== [typecheck] completed in 4120ms`.

For profile-based actions, `workingDirectory` is resolved before profile
detection and becomes the project root used for detection, Git scoping, and
execution. This supports nested projects in a monorepo without inspecting the
outer workspace as the selected project. The compatibility-only
`workspace_verify` action remains restricted to the opened workspace root; use
`project_verify` for nested projects.

Action resolution is fail-closed when generated work would be excessive. The
current limits are 500 changed files, 50 exactly mapped tests, 100 action steps,
20,000 command-preview characters, and profile evidence bounded to 20 entries
and 4,000 total characters. Exceeding a limit returns
`action_plan_too_large`; Workbridge never runs a partial subset silently.

The Node profile chooses its package manager from `package.json.packageManager`
first, then from a single recognized lockfile, and finally falls back to npm.
Supported managers are npm, pnpm, yarn, and bun. Multiple manager lockfiles are
rejected unless `packageManager` explicitly selects one. Git validation uses
`git rev-parse`, so normal checkouts and Git worktrees are handled consistently.

The Python profile selects `uv` from `uv.lock`, Poetry from `poetry.lock` or a
`[tool.poetry]` table, and otherwise uses `py` on Windows or `python3` on other
platforms. Conflicting uv and Poetry markers are rejected. `quick` runs
`compileall` and configured Ruff checks; `standard` additionally runs configured
Mypy and Pytest checks. Tool execution is enabled only by explicit configuration
files or a `tests` directory.

`test_changed/exact` reads staged, unstaged, and untracked Git paths and runs
only test files with an exact mapping. Workbridge maps `src/name.ts` to an
existing `src/name.test.ts` or `src/name.spec.ts`. Python maps modules to
existing `test_name.py` or `name_test.py` files and requires configured Pytest.
Generic Node and Chrome extension profiles are rejected until a runner-specific
exact mapping is available. When no mapping exists, use `project_verify/quick`.

### Compatibility policy

The public seven-tool set remains fixed. Action result contract v2 is the 1.1
minor-version boundary and adds structured step and profile metadata. New
actions, presets, profiles, warnings, and artifact entries may be added without
adding tools. `workspace_verify` remains available through the 1.x series.

Because 1.1 changes the advertised output schema for `run_workspace_action` and
the optional action fields on `write_stdin`, restart Workbridge and refresh or
recreate the connector binding before relying on contract v2 in an existing
conversation.

Use `dryRun: true` to inspect the resolved command and policy without executing
it. Unknown actions and presets return the available registry entries.

### Action result contract v2

Every `run_workspace_action` response identifies the resolved operation instead
of returning only generic process fields:

```text
contractVersion: 2
status: dry_run | running | completed | failed | cancelled | rejected
action
preset?
profile?
executed
policy
commandPreview?
steps[]
profileEvidence[]
warnings[]
artifacts[]
error?
```

`rejected` means the action was not executed because action resolution or input
validation failed. `failed` means a registered action step failed. Each step is
reported as `pending`, `running`, `completed`, `failed`, `cancelled`, or
`skipped`, with exit details and duration when available. When an action
continues as a process session, later `write_stdin` responses retain the full
action state. Sessions created by `exec_command` continue to return the ordinary
process contract.

## Core Environment Variables

| Variable | Purpose |
| --- | --- |
| `HOST` | Local bind host. Default: `127.0.0.1`. |
| `PORT` | Local port. Default: `7676`. |
| `DEVSPACE_CONFIG_DIR` | Directory containing persisted config and auth files. |
| `DEVSPACE_ALLOWED_ROOTS` | Comma-separated roots that workspaces may open. |
| `DEVSPACE_PUBLIC_BASE_URL` | Public origin, without `/mcp`. |
| `DEVSPACE_ALLOWED_HOSTS` | Optional Host-header allowlist override. |
| `DEVSPACE_TRUST_PROXY` | Trust one reverse-proxy hop when set to `1`. |
| `DEVSPACE_STATE_DIR` | SQLite, logs, and runtime state directory. |
| `DEVSPACE_WORKTREE_ROOT` | Root for managed Git worktrees. |
| `DEVSPACE_WORKSPACE_SESSION_MAX_AGE_DAYS` | Persisted workspace-session retention. Default: `30`. |

## OAuth

Workbridge uses a single-user OAuth approval flow.

| Variable | Default |
| --- | --- |
| `DEVSPACE_OAUTH_OWNER_TOKEN` | Generated by `devspace init`; minimum 16 characters. |
| `DEVSPACE_OAUTH_ACCESS_TOKEN_TTL_SECONDS` | `3600` |
| `DEVSPACE_OAUTH_REFRESH_TOKEN_TTL_SECONDS` | `2592000` |
| `DEVSPACE_OAUTH_SCOPES` | `devspace` |
| `DEVSPACE_OAUTH_ALLOWED_REDIRECT_HOSTS` | `chatgpt.com,localhost,127.0.0.1` |
| `DEVSPACE_OAUTH_MAX_REGISTERED_CLIENTS` | `50` |
| `DEVSPACE_OAUTH_INACTIVE_CLIENT_MAX_AGE_DAYS` | `90` |
| `DEVSPACE_OAUTH_AUTH_FAILURE_LIMIT` | `5` |
| `DEVSPACE_OAUTH_AUTH_FAILURE_WINDOW_SECONDS` | `300` |
| `DEVSPACE_OAUTH_AUTH_BLOCK_SECONDS` | `900` |
| `DEVSPACE_OAUTH_AUTH_FAILURE_DELAY_MS` | `250` |

Discovery endpoints:

```text
/.well-known/oauth-protected-resource/mcp
/.well-known/oauth-authorization-server
```

## Logging

| Variable | Default | Purpose |
| --- | --- | --- |
| `DEVSPACE_LOG_LEVEL` | `info` | `silent`, `error`, `warn`, `info`, or `debug`. |
| `DEVSPACE_LOG_FORMAT` | `json` | File-log format. `json` or `pretty`. |
| `DEVSPACE_LOG_FILE` | `1` | Enable rotating file logs. |
| `DEVSPACE_LOG_FILE_PATH` | `<state>/logs/devspace.jsonl` | File-log path. |
| `DEVSPACE_LOG_FILE_MAX_BYTES` | `10485760` | Rotation size; `0` disables size rotation. |
| `DEVSPACE_LOG_FILE_MAX_FILES` | `5` | Rotated files retained. |
| `DEVSPACE_LOG_CONSOLE_JSON` | `0` | Emit JSON instead of compact console rows. |
| `DEVSPACE_LOG_REQUESTS` | `1` | Log HTTP requests. |
| `DEVSPACE_LOG_ASSETS` | `0` | Log static asset requests. |
| `DEVSPACE_LOG_TOOL_CALLS` | `1` | Log tool calls. |
| `WORKBRIDGE_LOG_SHELL_COMMANDS` | `0` | Include redacted command previews. |

Command previews are disabled by default because commands may contain secrets.
The compact console uses fixed column widths so HTTP, MCP-session, tool, status,
and duration rows align.

## Skills and Child Environment

Skills are always enabled. Standard Agent Skills locations are loaded together
with paths from:

```text
DEVSPACE_SKILL_PATHS
```

Only advertised `SKILL.md` files and files under an activated skill directory
may be read outside the workspace.

Variables passed to child commands are restricted. Add explicitly required
names to:

```text
DEVSPACE_CHILD_ENV_ALLOWLIST
```

## Workspace and MCP Session Lifecycle

Workspace IDs are persisted and may be restored after a server restart while
their configured retention window remains valid. Running process session IDs do
not survive a restart.

MCP transports idle for 24 hours are closed by periodic cleanup. Initialization-
only sessions are closed after 15 minutes. Remaining transports are closed
during server shutdown. Compact `MCPSESS` rows report current session metrics;
`MCPWARN` is emitted when active-session warning thresholds are crossed.

## Commands

```bash
npx @waishnav/devspace init
npx @waishnav/devspace serve
npx @waishnav/devspace doctor
npx @waishnav/devspace config get
npx @waishnav/devspace config set publicBaseUrl https://devspace.example.com
npm run control -- pause --reason "PC restart"
npm run control -- status
npm run control -- resume
```

## Native Artifact Download

`download_artifact` is part of Workbridge's fixed seven-tool surface. The tool
is always advertised so reconnecting from Windows to Linux does not change the
MCP schema.

The secure download implementation currently runs on Linux. On Windows, macOS,
and BSD, the same tool remains visible but returns an explicit unsupported-
platform result without writing a file.

| Variable | Default | Purpose |
| --- | --- | --- |
| `DEVSPACE_ARTIFACT_MAX_FILE_BYTES` | `104857600` | Maximum streamed size of one native file (100 MiB). |

The same size setting may be persisted in `~/.devspace/config.json` as
`artifactMaxFileBytes`. The former `DEVSPACE_ARTIFACTS` enable flag is ignored;
tool visibility is fixed.

`download_artifact` accepts the native file object supplied by the MCP host, a
`workspaceId` returned by `open_workspace`, and a relative workspace `path`.
It refuses existing destinations, arbitrary URLs, absolute paths, traversal,
and symlinked parent directories. See [Native File Download](artifact-exchange.md)
for the connector shape and security boundaries.
