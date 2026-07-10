# Workbridge Code Review Action Plan

- Review date: 2026-07-11 JST
- Repository: `signal-forge-lab/devspace`
- Branch: `feature/workbridge-stable-surface`
- Review baseline: `c4e6a1d`
- Upstream reviewed: `upstream/main` at `6ccefbf`

## 1. Review result summary

Workbridge currently passes typecheck, the full test suite, production build,
`doctor`, `npm audit`, package dry-run, and `git diff --check`. The current
stable `codex` tool surface and the recent path-redaction changes are suitable
for the intended single-user workflow.

The highest-priority remaining risks are filesystem boundary handling and
shell-command logging. These are not detected by the existing happy-path test
suite and must be addressed as security regression work.

## 2. Upstream update assessment

`upstream/main` advanced from `d031874` to `6ccefbf`.

Relevant upstream changes:

1. `629318c` — Fix checkout workspace opening for Windows drive roots.
2. `71d7f07` — Resolve symlinked AGENTS context files.
3. `94afa09` — Reject AGENTS symlink targets outside allowed context roots.
4. `6242f29` — Fix AGENTS realpath containment on CI.
5. `2fd5dc3` — Fix Windows AGENTS fixture discovery.

The upstream change is limited to `src/workspaces.ts` and
`src/workspaces.test.ts`. A trial merge reported no conflicts with the current
Workbridge branch. The update should be merged before implementing additional
workspace-boundary changes.

## 3. Priority plan

### P0-1: Merge current upstream/main

Status: completed on 2026-07-11

Purpose:

- import the Windows checkout-root fix;
- prevent initial AGENTS/CLAUDE context loading through symlinks that resolve
  outside the workspace or configured agent directory;
- retain Workbridge's workspaceId reuse messaging.

Acceptance checks:

- upstream merge completes without unresolved conflicts;
- `npm run typecheck`, `npm test`, `npm run build`, and `git diff --check` pass;
- Workbridge-specific tests and tool descriptions remain intact.

### P0-2: Enforce realpath containment for general file tools

Status: completed on 2026-07-11

Affected tools:

- `read`
- `write`
- `edit`
- `grep`
- `glob` / find
- `ls`

Problem:

The current resolver in `src/roots.ts` checks the lexical path produced by
`resolve()` and `relative()`. A workspace-local symlink or Windows junction can
therefore point outside the workspace while the visible path still appears to
be contained. A controlled review test confirmed that an external file could be
read through such a junction.

Required design:

- use the real workspace root as the containment anchor;
- resolve the target or its nearest existing parent with `realpath()`;
- reject targets whose real path is outside the allowed root;
- support new files by checking the nearest existing parent;
- preserve explicitly advertised skill reads by checking against their own
  allowed real roots;
- apply the same boundary logic to read and mutation tools;
- keep `apply_patch` behavior compatible with its existing confined resolver.

Required regression tests:

- external file symlink is rejected;
- external directory symlink is rejected;
- Windows junction escape is rejected;
- creation below an escaped parent is rejected;
- a symlink that resolves inside the workspace remains usable;
- advertised skill files remain readable only inside their allowed skill root.

Implemented result:

- added `resolveAllowedRealPath()` as the shared realpath-aware resolver;
- applied it to read, write, edit, grep, glob/find, and ls;
- retained lexical output paths while validating the real target or nearest
  existing parent;
- added cross-platform junction/symlink and missing-target regression tests.

### P0-3: Honor shell-command logging configuration

Status: completed on 2026-07-11

Problem:

`DEVSPACE_LOG_SHELL_COMMANDS` defaults to disabled and the security
documentation says command previews are disabled unless explicitly enabled.
However, the current `logToolCall()` always records a `commandPreview` whenever
a command is supplied.

Required behavior:

- `exec_command` and `bash` command previews are logged only when
  `DEVSPACE_LOG_SHELL_COMMANDS=1`;
- `write_stdin` does not log submitted characters;
- `launch_workspace_task` records task/template metadata by default, not its
  resolved command;
- enabling shell-command logging preserves path redaction;
- compact console and JSONL behavior follow the same policy;
- tests cover both enabled and disabled configurations.

Implemented result:

- command previews and command lengths are omitted by default for
  `exec_command`, `bash`, and `launch_workspace_task`;
- `DEVSPACE_LOG_SHELL_COMMANDS=1` explicitly enables the redacted preview;
- `write_stdin` never records submitted characters;
- workspace-task logs retain task, template, and dry-run metadata without
  requiring the resolved command text.

## 4. P1 candidates

### P1-1: Centralize response-path sanitization

Potential remaining generated-path surfaces include:

- global AGENTS/CLAUDE paths outside the workspace;
- skill diagnostics;
- tool error messages;
- backend detail fields such as `fullOutputPath`.

System-generated paths should be sanitized while file contents should remain
unmodified.

### P1-2: Minimize child-process environment inheritance

`exec_command` and workspace tasks currently inherit the full Workbridge
environment. Introduce a safe baseline plus an explicit pass-through allowlist,
and always exclude Workbridge OAuth credentials and common secret-name patterns.

### P1-3: Make workspace tasks template-only by default

Keep dynamic `args` behind an explicit opt-in. Treat workspace tasks as a
workflow boundary rather than a complete operating-system security boundary.

## 5. P2 candidates

- Stop buffering stdout/stderr entirely when process `outputMode` is `status`.
- Add OAuth authorization failure rate limiting and redirect-scheme checks.
- Add idle cleanup for MCP transports and stale workspace sessions.
- Clean obsolete `refs/devspace/review/*` references when widgets are enabled.
- Unify package, MCP server, startup, and `doctor` version sources.
- Unify the documented and CLI-enforced Node version range.
- Classify expected authentication/discovery HTTP probes separately from real
  request failures.

## 6. P3 maintainability candidates

- Split the approximately 2,000-line `src/server.ts` into tool, transport,
  response-sanitizer, authentication, and HTTP logging modules.
- Add linting and coverage thresholds.
- Separate security regression tests from general unit tests.
- Reduce large UI chunks through lazy loading where useful.

## 7. Current strengths to preserve

- OAuth tokens are persisted as hashes rather than plaintext.
- Refresh-token rotation is transactional.
- SQLite state files use restrictive permissions where supported.
- `apply_patch` already performs realpath-aware confinement and atomic writes.
- Process sessions are bound to the creating workspaceId.
- CI covers Windows, macOS, and Linux.
- Current dependency audit reports no known vulnerabilities.
- The `codex` profile keeps the model-facing tool surface relatively small.
- Recent command/output path redaction and workspace-task output suppression
  should remain covered by regression tests.

## 8. Execution order

1. P0-1 upstream merge
2. P0-2 general file-tool realpath confinement
3. P0-3 shell-command logging policy
4. Re-run full validation and review the remaining P1 items

Each completed implementation step must be committed separately. Push remains
user-approved only.
