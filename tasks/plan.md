# Implementation Plan: Workbridge Modern MCP Phase 5

## Overview

Move static Workbridge tool-registration inputs from the Modern MCP request path
to process startup while preserving a fresh Modern McpServer and adapter for
every request, the existing Zod schemas, request metadata semantics, live Soft
Pause state, Monitor behavior, and the public tool contract.

## Architecture Decisions

- Record the existing createMcpServer registration flow once at startup
  through the existing registrar boundary; do not hand-copy tool definitions.
- Store only shallow immutable catalog entries. Keep Zod schemas and definition
  objects unfrozen so SDK validation and registration semantics remain intact.
- Bind the recorded definitions and already-wrapped handlers into each fresh
  Modern adapter. Legacy createMcpServer calls remain unchanged.
- Keep src/server.ts limited to one startup compile hook and one per-request
  bind hook; keep catalog mechanics in a Workbridge-owned module.

## Task List

### Phase 1: Baseline and design

- [x] Task 1: Re-audit the canonical f5b8149 registration path and dependency
  behavior.
- [x] Task 2: Run the unchanged benchmark across tools/list and read at
  concurrency 1/2/4/8/16/32 and preserve the results.

### Checkpoint: Baseline

- [x] Canonical checkout is unchanged.
- [x] Before benchmark output is captured with the current script and settings.

### Phase 2: Catalog foundation

- [x] Task 3: Add a recording registrar and immutable shallow catalog with
  compile-once and bind-many behavior.
- [x] Task 4: Add focused catalog tests for identity reuse, fresh-server
  binding, handler behavior, and post-compile mutation rejection.

### Checkpoint: Catalog

- [x] Catalog tests pass.
- [x] No Zod schema deep-freeze or JSON Schema conversion is introduced.

### Phase 3: Modern integration

- [x] Task 5: Compile the existing Workbridge registration flow once during
  startup and bind the catalog into each fresh Modern adapter.
- [x] Task 6: Extend Modern server tests and verify the existing server
  integration tests for tool surface, metadata, Soft Pause, Monitor, and
  fresh-server isolation.

### Checkpoint: Integration

- [x] Targeted tests pass.
- [x] npm run baseline:tools:check passes.
- [x] Fresh McpServer per request remains structurally and behaviorally true.

### Phase 4: Measurement and handoff

- [x] Task 7: Build and run the same twelve benchmark cases after the change.
- [x] Task 8: Compare before/after registration p50/p95/p99, server total,
  throughput, ELU, and loop delay.
- [x] Task 9: Run npm run verify:rebase, review the final diff, commit the
  dedicated branch, and prepare the reviewer report.

### Checkpoint: Complete

- [x] All Phase 5 acceptance criteria are met.
- [x] Canonical integration, live restart, and push remain unperformed.

## Risks and Mitigations

| Risk | Impact | Mitigation |
| --- | --- | --- |
| SDK registration mutates definitions | High | Inspect the installed SDK and pass the same shallow definition references only if mutation is absent; otherwise copy only the mutated top-level fields. |
| A wrapper captures request state at compile time | High | Trace every wrapper and test request metadata, Soft Pause, and Monitor execution after compilation. |
| Catalog changes public tools | High | Keep createMcpServer as the single registration source and run the tool-schema baseline. |
| Startup compilation changes legacy behavior | Medium | Use the catalog only in the Modern request factory; leave legacy call sites untouched. |

## Open Questions

- The final reviewer decides whether the measured registration improvement is
  sufficient for canonical integration and whether SDK-level registration cost
  merits a later phase.

Approval: the user-provided Phase 5 execution prompt authorizes this plan and
the dedicated-worktree implementation.
