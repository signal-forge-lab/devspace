# Workbridge AI Guardrails Review — 2026-07-26

## Scope

This review records the first minimal lint and critical-boundary coverage pass
for an AI-maintained Workbridge codebase.

Baseline:

```text
branch: workbridge-fixed-surface
base HEAD: b4bf342
version: 1.3.1
```

## Minimal lint decision

The first trial enabled unused-variable and unnecessary-assertion rules in
addition to async-safety rules. It reported 26 existing findings, primarily:

- retained upstream UI/subagent declarations in `src/server.ts` that are not
  reachable under the fixed Workbridge tool surface;
- type assertions that TypeScript currently considers redundant;
- one unused import in an upstream-derived local-agent file.

Fixing those findings would create broad downstream changes without a proven
runtime benefit. Those two rule families were therefore rejected.

The accepted lint surface is limited to:

```text
unhandled promises
awaiting non-Promise values
misused promises in conditions and spreads
async callbacks passed to forEach
unreachable statements
constant binary expressions
```

Formatting, quote style, import order, line length, and automatic source
rewrites are intentionally excluded.

The accepted configuration passes the existing source tree without requiring a
source-code cleanup commit.

## Critical coverage scope

`npm run coverage:critical` runs the complete test suite while reporting only
these boundaries:

```text
src/mcp-session-lifecycle.ts
src/workspace-action-process-runner.ts
src/process-sessions.ts
src/soft-pause.ts
src/session-monitor-integration.ts
src/oauth-security.ts
src/roots.ts
src/workspaces.ts
```

The first observation before the targeted test additions was:

| Scope | Lines | Branches | Functions |
| --- | ---: | ---: | ---: |
| Critical boundaries total | 89.41% | 81.41% | 90.97% |
| MCP session lifecycle | 87.39% | 90.69% | 84.21% |
| OAuth security | 86.58% | 93.10% | 80.00% |
| Process sessions | 88.11% | 84.21% | 90.90% |
| Roots | 100.00% | 90.00% | 100.00% |
| Session Monitor integration | 96.18% | 80.32% | 100.00% |
| Soft Pause | 97.58% | 73.68% | 100.00% |
| Workspace Action runner | 80.53% | 65.90% | 83.33% |
| Workspaces | 90.63% | 78.49% | 91.66% |

No coverage threshold is configured. These values are an observation, not a
quality score or release gate.

## Targeted test additions

Two uncovered areas were judged important enough to test:

1. OAuth authorization-attempt pruning must retain an active block and remove
   it after expiry; the authorization delay helper must support both immediate
   and positive delays.
2. MCP session cleanup must log a transport-close failure without leaving the
   failed session registered, and a pressure threshold must be able to clear and
   warn again after the active session count falls below it.

These tests assert state and emitted events rather than merely executing lines.

After those tests were added, the observed values became:

| Scope | Lines | Branches | Functions |
| --- | ---: | ---: | ---: |
| Critical boundaries total | 91.12% | 81.62% | 93.23% |
| MCP session lifecycle | 96.74% | 90.19% | 89.47% |
| OAuth security | 100.00% | 91.89% | 100.00% |

The change in percentages is evidence that the new tests execute the intended
paths. It is not a new minimum threshold.

## Accepted uncovered categories

The following gaps are not automatically defects and are not filled merely to
raise coverage:

- PTY-only paths that depend on the optional native `node-pty` implementation
  and the host platform;
- process spawn error races that require invasive runtime mocking;
- defensive branches for malformed optional result metadata;
- display-only fallback branches in Monitor and Soft Pause formatting;
- filesystem traversal failure branches already protected by fail-closed
  behavior at a lower-level boundary.

Revisit these only when a concrete defect, platform regression, or upstream
change makes the branch materially important.

## Commands

```text
npm run lint
npm run coverage:critical
npm run verify:rebase
```

Coverage artifacts are generated under the ignored `reports/` directory and
are not committed.
