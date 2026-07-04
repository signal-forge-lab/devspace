# Workbridge

Host-side filter first rule:

Schema discovery rule:

- Avoid repeated MCP host schema discovery during normal workflow.
- Prefer local `tool_registry_summary` logs to verify exposed Workbridge tools.
- If schema discovery is unavoidable, use one exact query and then stop.

- If any tool call is filtered before reaching Workbridge, immediately call
  `record_tool_event` when available.
- Use only the minimum stable fields: `toolName`, `operation`, and `category`.
- Do not include `commandShape` or `note` in normal workflow.
- After recording, switch to one safer tool shape. Do not retry the same filtered
  shape.

Tool discovery budget:

- Do not repeatedly rediscover Workbridge tools through the host connector. If a
  tool is already visible in the current thread, call it directly.
- Tool schema descriptions must stay short. Put long workflow rules in this file
  or docs instead of model-facing schema descriptions.
- Avoid naming many sibling tools inside one tool description because host-side
  discovery matches description text and can return unrelated tools.

This project exposes a local development workspace over MCP so ChatGPT, Claude,
or another MCP-capable host can operate directly on this machine's approved
development directories.

The goal is not to delegate work to a separate local coding agent. The MCP host
should call tools that read files, edit files, search code, and run shell
commands directly against approved local project roots.

Pi's SDK is currently used as the backend adapter for mature local coding
primitives such as read, edit, write, grep, find, ls, and bash. Workbridge wraps
those primitives behind a remote Streamable HTTP MCP interface, suitable for use
through a Cloudflare Tunnel.

The model-facing workflow is workspace based. MCP clients should call
`open_workspace` once per local project directory or worktree, then reuse the
returned `workspaceId` for subsequent tool calls in that same folder. Do not
call `open_workspace` again for the same folder unless the `workspaceId` is
rejected as unknown, the client switches folders/worktrees or checkout/worktree
mode, or the user explicitly asks to reopen. `AGENTS.md` files are returned
automatically by `open_workspace` and by later tool calls when the requested path
enters a directory with instructions that have not been loaded for that
workspace.

Core constraints:

- Treat this as remote access to the local machine; security is part of the
  core design, not a later add-on.
- Start with a narrow filesystem allowlist.
- Prefer explicit, inspectable tool calls over autonomous local agent loops.
- Keep the first version small enough to validate with real ChatGPT/Claude MCP
  clients before adding UI or workflow features.

ZIP-first read rule:

- Use `export_workspace_zip` plus `create_zip_download_url` before broad
  repository reading/searching.
- Mandatory ZIP-first triggers: likely reading 3 or more files; inspecting large
  files such as `server.ts` or large extension scripts; searching across the
  repository; inspecting `node_modules`, SDK files, generated files, or
  documentation across multiple paths; preparing repeated read/search calls for
  exploration; or any host-side filter during read/search/shell-inspection.
- When several known files need small, specific ranges, create a workspace index
  and use `read_index_ranges`. Legacy direct read tools are hidden unless
  `DEVSPACE_ENABLE_LEGACY_READ_TOOLS=1` is set.
- Treat a task as read-heavy even when target files are known if it needs many
  function lookups, residue checks, version sweeps, or repeated reads across
  those files. Do not classify such work as a tiny targeted edit.
- If indexed range reading is unavailable, switch to ZIP-first before falling
  back to legacy direct reads.
- If ZIP transfer itself cannot be downloaded or extracted by the host, state
  that failure and then shrink to `grep_context`, `file_outline`, and focused
  `read_index_ranges` only. Do not silently skip the ZIP attempt for read-heavy work.
- Do not treat Workbridge-side inspection of `.devspace/exports/*.zip` as ZIP
  transfer success. Opening or extracting the ZIP on the same machine only
  verifies ZIP generation, not host transfer.
- Do not stream full ZIP entries such as Markdown files to the chat. If ZIP
  content must be inspected, use a bounded manifest/listing or small live range
  checks instead.
- MCP read/search budget before ZIP is at most 1 `workspace_snapshot`, 1
  `file_outline`, and 1 focused `read_index_ranges`. If more context is needed, stop and
  switch to ZIP transfer.
- ZIP exports must include Git-tracked files only and are read-only snapshots.
  Treat them as cached context, not as the live workspace.
- Prefer reading, searching, and broad repository inspection from the downloaded
  ZIP snapshot when available.
- Make all file writes through stable MCP workspace tools such as `edit` or
  `edit_by_line_range`; advanced tools such as `replace_symbol` and `write` may
  be hidden in the default ChatGPT-stable profile. Never edit only the ZIP
  snapshot. `edit_many` is hidden unless `DEVSPACE_ENABLE_EDIT_MANY=1` is set.
- Before applying edits based on a ZIP snapshot, re-read or hash-check the live
  target file/range through MCP and use `expectedHash` when available.
- After a successful edit, re-read the edited live file through MCP and update
  the host-side snapshot/cache for that file. Re-export the ZIP after larger
  edit batches.
- Skip ZIP-first only when the task names one or two small files and no broad
  search is needed, the user explicitly asks not to use ZIP transfer, the
  repository is not clean enough to snapshot safely, or the task is a tiny
  targeted edit where the exact live location is already known.
- `read_zip_chunk` is not part of the normal workflow and should remain disabled
  unless the user explicitly asks to re-test chunk transfer.

Repository finalization rules:

- Finalization is part of MCP implementation work unless the user says not to do it.
- Use `workspace_snapshot` with Git included as the first status check when a status check is needed.
- Prefer the stable finalization path: `git_commit_files` with the exact intended
  file list and commit message.
- If `git_commit_files` is host-filtered, prefer a focused `bash` git fallback.
  `git_stage_files` and `git_commit_staged` may be hidden in the default
  ChatGPT-stable profile; do not keep retrying a blocked commit shape.
- Do not default to asking the user to finish this step locally.
- Use `git_stage_files` plus `git_commit_staged` only when those tools are
  visible and hunk staging, an already staged index, or an explicit staged
  workflow is required. Prefer `git_commit_files` for normal small commits.
- Use `git_status` only when `workspace_snapshot` is insufficient. In the
  default ChatGPT-stable profile, `git_recent_commits` may be hidden; use a
  focused `bash`/`git log` only when recent commits are actually needed.
- If one tool shape fails, record the filter when possible and try one safer
  different shape. If `record_tool_event` itself is filtered, do not retry the
  filter recording call.
- If every MCP path fails, report that finalization could not be completed.

Log correlation rules:

- Manual `tool_trace_start` and `tool_trace_end` tools are disabled for normal
  workflow.
- Workbridge logs should rely on sanitized correlation fields instead:
  `conversationIdHash` when an allowlisted conversation-like header exists;
  otherwise, tool logs with `workspaceId` should group by workspace, while
  HTTP-only logs may fall back to MCP session or request metadata.
- Never log raw conversation-like header values. Only log the allowlisted header
  name and a short hash.

Host-side filter logging rules:

- Follow the Host-side filter first rule at the top of this file.
- A ChatGPT/OpenAI safety check can filter a tool call before it reaches Workbridge.
  Those filters do not appear in normal `tool_call` logs.
- If `record_tool_event` is not visible, explicitly search/list tools for it
  before continuing. If it still is not available, state in the final response
  that the filter could not be recorded in Workbridge logs.
- Log analysis failure rates only cover calls that reached Workbridge. Treat
  unrecorded ChatGPT/OpenAI-side filters as out-of-band unless a
  `tool_event_report` exists.
