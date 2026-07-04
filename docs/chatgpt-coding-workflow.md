# ChatGPT Coding Workflow

Workbridge brings a DevSpace-compatible coding-agent loop to ChatGPT and other MCP hosts:
inspect the repo, follow local instructions, make scoped edits, run
verification, and show the user what changed.

## Open One Workspace

ChatGPT should call `open_workspace` once for a project folder:

```json
{
  "path": "~/work/my-project"
}
```

The result includes a `workspaceId`. All later file, search, edit, show-changes,
and shell calls should reuse that same `workspaceId`.

Do not reopen the same folder unless:

- the `workspaceId` is rejected as unknown
- the user switches to another folder
- the user switches between checkout and worktree mode
- the user explicitly asks to reopen

## Checkout Mode

Checkout mode is the default. Workbridge opens the actual directory:

```json
{
  "path": "~/work/my-project"
}
```

Use this when the user wants ChatGPT to work in the current checkout.

## Worktree Mode

Use worktree mode for isolated parallel work:

```json
{
  "path": "~/work/my-project",
  "mode": "worktree"
}
```

Managed worktrees are created under:

```text
~/.devspace/worktrees
```

Worktree mode requires a Git repository with at least one commit. It starts from
`HEAD` unless `baseRef` is provided.

Uncommitted source checkout changes are not copied into the managed worktree.
Workbridge reports when the source checkout was dirty so the model can decide how
to proceed with the user.

## Project Instructions

When a workspace opens, Workbridge loads root-level instruction files:

- `AGENTS.md`
- `AGENTS.MD`
- `CLAUDE.md`
- `CLAUDE.MD`

Nested instruction files are returned as `availableAgentsFiles`. The model
should read the relevant nested file before working under that directory.

This keeps instructions explicit and inspectable instead of silently injecting
new context during later tool calls.

## Skills

Skills are enabled by default for coding-agent workflows.

Workbridge discovers standard Agent Skills from:

- `~/.agents/skills`
- project `.agents/skills`

It also keeps compatibility with:

- `DEVSPACE_AGENT_DIR/skills`, defaulting to `~/.codex/skills`
- additional paths from `DEVSPACE_SKILL_PATHS`

Legacy project paths such as `.pi/skills` can be added through `DEVSPACE_SKILL_PATHS` when needed.

When `open_workspace` returns matching skills, the model should read the
advertised `SKILL.md` before following that skill.

Skill paths may be outside the workspace. DevSpace only permits reading:

- advertised `SKILL.md` files
- files under a skill directory after that skill's `SKILL.md` has been read

Set `DEVSPACE_SKILLS=0` to hide skills from workspace output.

## Tool Names

Default Workbridge visible tools:

- `open_workspace`
- `workspace_snapshot`
- `bash`
- `create_workspace_index`
- `grep_context`
- `file_outline`
- `read_index_ranges`
- `edit`
- `edit_by_line_range`
- `git_status`
- `git_commit_files`
- `record_tool_event`- `bash`

Optional hidden tools are exposed only by env flag:

- `DEVSPACE_ENABLE_LEGACY_READ_TOOLS=1`: `read`, `read_many`
- `DEVSPACE_ENABLE_EDIT_MANY=1`: `edit_many`
- `DEVSPACE_ENABLE_ZIP_EXPORT_TOOLS=1`: ZIP export/download tools
- `DEVSPACE_ENABLE_ZIP_IMPORT_TOOLS=1`: ZIP import/extract tools
- `DEVSPACE_ENABLE_ZIP_IMPORT_PROBE_TOOLS=1`: optional ZIP import probe tools
- `DEVSPACE_ENABLE_CODEX_CLI=1`: `run_codex_cli`
- `DEVSPACE_ENABLE_TASK_TOOLS=1`: `task_checkpoint`, `task_resume`

DevSpace logs a `tool_registry_summary` event at server startup. Use that local
log event to verify exposed tools, hidden tools, enabled profiles, and feature
flags instead of repeatedly asking the MCP host to rediscover tool schemas.

By default, DevSpace also runs in `DEVSPACE_TOOL_MODE=minimal`, so dedicated
`grep`, `glob`, and `ls` tools are hidden. Prefer `grep_context`,
`file_outline`, and `create_workspace_index` plus `read_index_ranges` for
inspection. Use `bash` only when a structured tool is insufficient.

These helpers are optional, but they must be available on the PATH of the shell
that starts DevSpace. After installing a helper, restart the terminal and then
restart `devspace serve` so the MCP shell can see it.

## Workbridge tool selection notes

- Use `workbridge_guide` first when the client is unfamiliar with Workbridge.
- Use `apply_patch` for Codex patch format in `DEVSPACE_TOOL_MODE=codex`.
- Use `apply_unified_patch` for hash-guarded unified diffs with `expectedBase`.
- Use `bash` for bounded minimal/full-mode commands.
- Use `exec_command` and `write_stdin` for codex-mode long-running or interactive process sessions.
- `run_codex_cli` launches a local Codex CLI wrapper and is separate from `DEVSPACE_TOOL_MODE=codex`.

Use `DEVSPACE_TOOL_MODE=full` to restore dedicated search and directory tools.

The experimental Codex-style surface is enabled with
`DEVSPACE_TOOL_MODE=codex`. It exposes:

- `open_workspace`
- `read`
- `apply_patch`
- `exec_command`
- `write_stdin`

Use `DEVSPACE_TOOL_MODE=full` to restore dedicated search and directory tools.
Use `DEVSPACE_TOOL_MODE=codex` to expose the Codex-style surface:
`open_workspace`, `read`, `apply_patch`, `exec_command`, and `write_stdin`.
In codex mode, `write`, `edit`, `bash`, `grep`, `glob`, and `ls` are not
registered. `exec_command` returns a process session ID when a command is still
running after its yield window. Use `write_stdin` to poll it, send input, resize
a PTY, or send Ctrl-C. Set `tty: true` only for commands that need a terminal.

Use `create_workspace_index` plus `read_index_ranges` for known files and known
line ranges, especially when multiple files need inspection. `create_workspace_index`
acts like an ensure operation: by default, identical live inputs reuse the same
index and cache-hit responses omit preview entries unless `includePreview=true`.
Use `refresh=true` only when a task explicitly needs a fresh index. Use the returned `indexId` directly with `grep_context` or `file_outline` plus optional `numbers` when inspecting only indexed files. Use `grep_context`
for bounded text search with surrounding lines instead of shell-based `rg` /
`grep` when possible. Use `file_outline` before broad reads to inspect
functions, classes, interfaces, types, constants, methods, and Markdown headings
in a single file.

Prefer `edit` for small single-file replacements and `edit_by_line_range` for
bounded line updates. Advanced edit helpers such as `replace_symbol`,
`insert_by_anchor`, and `write` are hidden in the default Workbridge profile;
use the remaining stable tools first.

Skip ZIP-first only when the task names one or two small files and no broad
search is needed, the user explicitly asks not to use ZIP transfer, the
repository is not clean enough to snapshot safely, or the task is a tiny
targeted edit where the exact live location is already known.

`read_zip_chunk` is disabled for normal operation. Re-enable or re-test chunk
transfer only when the user explicitly asks for chunk-transfer diagnostics.

## Show Changes

By default, `DEVSPACE_WIDGETS=off`.

Use `DEVSPACE_WIDGETS=full` to attach widget UI to exposed tools, or
`DEVSPACE_WIDGETS=changes` to expose the aggregate show-changes flow. Keep the
default `off` setting during ChatGPT streaming-stability tests.

When `show_changes` is exposed, models should call it exactly once after the
final file modification in any turn that changes files. The tool only requires
the `workspaceId`; DevSpace automatically compares against the last shown
checkpoint and advances that checkpoint after rendering the aggregate diff.

## Shell Use

The shell tool is for commands that belong in a terminal:

- tests
- builds
- package scripts
- environment checks

Prefer dedicated Git tools for Git operations and avoid shell-based `git status`
or `git diff --stat` loops. Avoid shell heredocs in normal workflow, including
read-only Python heredocs, because the heredoc command shape is filter-prone.
Split long `rg`/`grep` patterns into small focused searches, and prefer ZIP-first
for read-heavy exploration.

File writes should go through stable edit tools such as `edit` or
`edit_by_line_range` rather than shell redirection, heredocs, `tee`, `sed -i`, or
generated scripts.
