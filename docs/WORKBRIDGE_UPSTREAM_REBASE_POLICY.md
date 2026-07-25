# Workbridge Upstream Rebase Maintenance Policy

## Status

This document is a mandatory project instruction for Workbridge maintenance,
refactoring, review, and feature development.

Workbridge is maintained as a downstream extension of upstream DevSpace. The
project is expected to rebase onto upstream periodically. Reducing future rebase
cost and avoiding semantic regressions are primary architectural constraints,
not optional cleanup goals.

## Core rule

Prefer this structure:

```text
upstream-owned code
  -> small, explicit integration hook
    -> Workbridge-owned module
      -> Workbridge-specific implementation
```

Do not move upstream-owned implementation into a new downstream architecture
merely to make the current tree look cleaner.

## Classify files before editing

Before a structural change, determine whether each target file is:

1. **Upstream-owned**: the file exists in the upstream base and is maintained by
   upstream.
2. **Workbridge-owned**: the file was introduced by the Workbridge downstream
   branch.
3. **Integration boundary**: an upstream-owned file containing Workbridge hooks.

Re-check this classification after every upstream rebase. Do not rely only on
an old file list.

Current Workbridge-owned examples include:

```text
src/project-profiles.ts
src/workspace-actions.ts
src/workspace-action-plans.ts
src/mcp-session-lifecycle.ts
src/session-monitor.ts
src/session-monitor-ui.ts
src/soft-pause.ts
src/workspace-json-artifact.ts
```

Current high-conflict integration boundaries include:

```text
src/server.ts
src/process-sessions.ts
src/config.ts
src/cli.ts
src/artifact-tools.ts
src/workspaces.ts
src/logger.ts
```

The examples above are descriptive, not permanent. Use Git history and the
current upstream base to confirm ownership.

## Rules for upstream-owned files

- Minimize changed lines and changed regions.
- Preserve upstream control flow, naming, file layout, and formatting whenever
  possible.
- Prefer a small adapter call, callback, dependency injection point, or
  registration hook over embedding a complete Workbridge subsystem.
- Avoid broad moves, renames, formatting passes, and responsibility splits.
- Do not refactor upstream PTY, process spawning, polling, cancellation, OAuth,
  or MCP routing code without a concrete defect or approved requirement.
- When upstream adds an equivalent capability, prefer adapting to upstream and
  deleting redundant downstream code rather than maintaining two systems.

## Rules for Workbridge-owned files

- Workbridge-specific behavior should normally live here.
- Internal splitting is allowed when it improves a concrete maintenance or
  testing problem, but it is not automatically a rebase improvement.
- File size alone is not a reason to split a Workbridge-owned file.
- Keep public contracts, result schemas, and accepted fail-closed behavior
  stable unless a change is explicitly approved.

## Special guidance for current integration hotspots

### `src/server.ts`

Extract only Workbridge-specific concerns. Keep the upstream server structure as
intact as practical. Suitable extraction targets include Workbridge tool
registration, Session Monitor routing, Soft Pause integration, and Workbridge
session lifecycle wiring. Avoid a wholesale server architecture rewrite.

### `src/process-sessions.ts`

Preserve upstream process spawning, PTY/non-PTY behavior, output buffering,
polling, and cancellation structure where possible. Extract Workbridge-specific
Workspace Action planning, step state, artifacts, redaction context, and result
contract logic rather than reorganizing the entire process subsystem.

### `src/project-profiles.ts`

This is Workbridge-owned. Splitting it may improve local maintainability but does
not materially reduce upstream rebase conflicts. Do not prioritize such a split
over reducing the patch surface in upstream-owned files.

## Required workflow before an upstream rebase

1. Ensure the working tree is understood and intentionally clean, or preserve
   intentional local work in an isolated worktree.
2. Create a **local** backup branch or ref pointing to the pre-rebase HEAD.
3. Record the upstream base and downstream HEAD.
4. Review Workbridge-specific accepted decisions and retired designs so conflict
   resolution does not accidentally revive removed behavior.
5. Do not push the backup ref or any other branch unless the user explicitly
   requests a remote operation.

## Required workflow during conflict resolution

- Resolve conflicts semantically, not by choosing all of `ours` or `theirs`.
- Preserve upstream fixes unless they conflict with an explicitly accepted
  Workbridge requirement.
- Reapply Workbridge behavior through the smallest viable integration surface.
- Delete downstream code made redundant by upstream when compatibility and tests
  confirm it is safe.
- Do not revive retired features such as dynamic tool surfaces, ZIP-first
  transfer, arbitrary shell actions, or session-count eviction without explicit
  approval.

## Required post-rebase verification

At minimum, run and review:

```text
npm run typecheck
npm run baseline:tools:check
npm test
npm run build
git diff --check
```

Also verify the following invariants:

- the fixed seven public tools remain unchanged unless explicitly approved;
- Action result contracts and fail-closed rejection behavior remain intact;
- MCP session cleanup, active-request protection, and shutdown behavior remain
  intact;
- process polling, input, PTY/non-PTY execution, and Ctrl+C cancellation remain
  intact;
- OAuth, allowed-root enforcement, path redaction, and artifact boundaries remain
  intact;
- Session Monitor and Soft Pause integration do not broaden public exposure or
  alter the fixed tool surface.

Review the final downstream diff against the new upstream base. A successful
test run is necessary but does not replace patch-surface review.

## Refactoring acceptance test

A structural refactor should satisfy at least one of these conditions:

- it removes Workbridge logic from an upstream-owned file;
- it reduces the number or spread of downstream-edited regions in an
  upstream-owned file;
- it creates a narrow and stable integration boundary;
- it fixes a concrete defect or security problem;
- it enables an explicitly approved feature with lower long-term rebase cost.

Reject or defer a refactor when it only changes file organization, naming, or
formatting without a measurable benefit under these conditions.

## Git, remote, and publication boundary

Git is used here primarily for local source control and safe recovery.

The following are **not default maintenance tasks**:

```text
remote push
remote branch creation or deletion
Git tag creation
GitHub Release creation
npm publish
public release preparation
```

Only add or perform those operations when the user explicitly requests them.
Local commits and local pre-rebase backup refs do not imply publication.
