# ChatGPT Coding Workflow

Workbridge exposes one stable coding workflow: open a workspace, inspect it,
apply a consolidated patch, and verify the result.

## Fixed Tools

```text
open_workspace
read
apply_patch
exec_command
write_stdin
run_workspace_action
```

The list and input schemas do not change with runtime options.

## Open One Workspace

Call `open_workspace` once per project folder or worktree:

```json
{
  "path": "~/work/my-project",
  "mode": "checkout"
}
```

Reuse the returned `workspaceId`. Reopen only when the ID is rejected, the user
switches folders or checkout/worktree mode, or explicitly asks to reopen.

`worktree` mode creates an isolated managed Git worktree. It requires a Git
repository with at least one commit and starts from `HEAD` unless `baseRef` is
provided.

## Instructions and Skills

`open_workspace` returns root `AGENTS.md`/`CLAUDE.md` content and paths to nested
instruction files. Read the relevant nested file before working below its scope.

Skills are always enabled. When a returned skill matches the task, read its
advertised `SKILL.md` before proceeding. Additional skill roots can be configured
through `DEVSPACE_SKILL_PATHS`.

## Inspect and Modify

Use `read` for file content. Use `exec_command` for searches, Git inspection,
tests, builds, and other ad hoc commands.

Use `apply_patch` for every file modification. Batch all related edits for one
logical implementation step into one patch. Avoid shell redirection, heredocs,
`tee`, generated editing scripts, and repeated one-file patches.

## Long-Running Commands

`exec_command` and `run_workspace_action` return a `sessionId` when the process
outlives the yield window. Use `write_stdin` to poll, send input, resize a PTY,
or send Ctrl-C.

Set `tty: true` only for interactive programs. On Windows, `exec_command` uses
`ComSpec`, normally `cmd.exe`; PowerShell is not selected automatically.

## Registered Actions

Use `run_workspace_action` when the operation should be repeatable and owned by
Workbridge rather than composed as an arbitrary command by the model.

```json
{
  "workspaceId": "ws_example",
  "action": "project_verify",
  "preset": "standard",
  "parameters": {},
  "dryRun": false
}
```

The Action Registry chooses the command, validates parameters, and attaches a
policy classification. New actions can be added without changing the MCP tool
schema.
