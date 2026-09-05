# Workbridge → DevSpace upstream PR candidates

Date: 2026-08-16

This document tracks Workbridge changes that may be suitable as focused upstream pull requests to `Waishnav/devspace`.

The goal is not to upstream every Workbridge difference. Prefer changes that are generally useful to DevSpace users, have a clear correctness/security/operability benefit, and can be reviewed independently without pulling in Workbridge-specific product behavior.

## Evaluation criteria

Each candidate is judged on:

- **Upstream value** — benefit to normal DevSpace users.
- **Evidence** — whether Workbridge already exercises the behavior in real use.
- **Scope** — whether the change can be isolated as one coherent PR.
- **Overlap risk** — whether upstream already has an equivalent fix or an active PR.
- **Regression risk** — likelihood of changing established DevSpace behavior.

Priority meanings:

- **A** — strong next-PR candidate.
- **B** — worthwhile, but inspect current upstream state first.
- **C** — possible improvement; only pursue with a concrete need or measurement.
- **Deferred** — do not file while overlapping upstream work is active or while the change remains Workbridge-specific.

## Candidate summary

| Priority | Candidate | Category | Upstream value | Scope | Overlap risk | Current recommendation |
|---|---|---|---|---|---|---|
| A | Limit inherited environment variables for child processes | Security | High | Small/medium | Low | Strong next candidate |
| A | Reduce unnecessary absolute local-path exposure | Security/privacy | High | Small if surface-specific | Low/medium | File as narrow, concrete leaks only |
| A- | Distinguish normal MCP/HTTP disconnects from transport failures | Bug/operability | High | Small/medium | Low | Good focused PR |
| B | Additional MCP session lifecycle hardening | Bug/reliability | High | Medium | High | Re-evaluate after overlapping upstream PRs settle |
| B | realpath/symlink/junction containment hardening | Security | High | Medium | Medium/high | Diff against current upstream before filing |
| C | Bounded structured logging / safe telemetry | Operability | Medium | Medium | Medium | Only extract independently useful pieces |
| C | Text-corruption / mojibake detection | Reliability/diagnostics | Medium/low | Small | Low | File only with reproducible host impact |
| C | Benchmark modern per-request MCP registration overhead | Performance | Unknown until measured | Small benchmark first | Low | Measure before optimizing |

## A — Limit inherited environment variables for child processes

### Problem

Commands launched by DevSpace can inherit the server process environment. If the server process contains credentials or unrelated service configuration, those values can become visible to child processes even when the command does not need them.

Examples of potentially sensitive inherited values include API tokens, cloud credentials, GitHub tokens, and provider-specific secrets.

### Workbridge value

Workbridge treats child-process environment inheritance as a local-authority boundary and limits what is inherited rather than assuming the parent environment is safe for every invoked command.

### Upstream fit

Strong. DevSpace explicitly executes commands with the local user's authority, so minimizing unnecessary credential propagation is aligned with its security model.

### Suggested PR shape

Keep this focused on process environment construction only. Avoid combining it with shell policy, tool permissions, or unrelated credential-storage changes.

Possible title:

`fix(security): limit inherited environment for child processes`

### Validation needed before filing

- Inventory which environment values DevSpace intentionally requires in children.
- Preserve common command execution behavior on Windows, macOS, and Linux.
- Add regression coverage proving allowed values survive and excluded sensitive values do not leak.

## A — Reduce unnecessary absolute local-path exposure

### Problem

Host-visible MCP results or logs can expose full local filesystem paths such as usernames, project directory names, repository locations, or temporary paths when the absolute path is not required for the host to act.

### Workbridge value

Workbridge has introduced path-redaction/normalization behavior on surfaces where the host only needs a workspace-relative or otherwise non-sensitive reference.

### Upstream fit

Strong when tied to a concrete response or log surface. Avoid a global path redaction layer because some DevSpace tools legitimately need exact local paths.

### Suggested PR shape

File one narrow PR per real leakage surface, for example:

- return workspace-relative paths where the workspace is already known;
- avoid temporary host paths in model-facing error text;
- avoid logging absolute internal paths when a stable logical identifier suffices.

### Validation needed before filing

- Identify exact model-facing/logging surfaces that expose unnecessary paths.
- Confirm the host does not rely on the absolute path for follow-up actions.
- Preserve actionable diagnostics for the local operator.

## A- — Distinguish normal disconnects from transport failures

### Problem

Normal connection termination, client cancellation, polling/SSE completion, and actual abnormal transport failures can look similar in logs. Treating all of them as warnings makes real incidents harder to identify and can produce noisy monitoring.

### Workbridge value

Workbridge has more precise lifecycle classification so expected closure is not reported like a transport defect.

### Upstream fit

Good. This improves diagnosis without changing the MCP contract if implemented as logging/lifecycle classification rather than retry policy.

### Suggested PR shape

`fix(logging): distinguish normal MCP disconnects from transport failures`

Do not mix in automatic reconnection, tunnel management, or client-specific retry behavior.

### Validation needed before filing

- Reproduce at least one expected disconnect and one true abnormal close.
- Confirm status/log severity classification is stable for both legacy and modern MCP paths where applicable.

## B — Additional MCP session lifecycle hardening

### Candidate Workbridge behaviors

Potentially reusable pieces include:

- protecting active requests from stale-session cleanup;
- one-shot/robust cleanup paths;
- shutdown ordering and close-result accounting;
- stale/capacity behavior that avoids evicting active sessions;
- session lifecycle metrics useful for diagnosis.

### Why this is not an immediate PR

Upstream has already received session lifecycle work and has had additional active PRs in this area. A new PR should only contain behavior still missing after those changes settle.

### Recommendation

Re-diff Workbridge against the then-current `upstream/main` before implementing anything. Do not submit a broad "session hardening" bundle.

## B — realpath / symlink / junction containment hardening

### Problem

String-prefix path checks are not sufficient when symlinks, junctions, aliases, or canonicalization differences allow a path to resolve outside an approved root.

### Workbridge value

Workbridge has stronger canonical-path/realpath handling around allowed-root and workspace boundaries.

### Upstream fit

Potentially high, but upstream has already fixed multiple Windows/symlink escape cases. The remaining delta must be proven before a new PR is justified.

### Validation needed before filing

- Compare `roots`, workspace open, managed worktree, and instruction-file path handling against current upstream.
- Test Windows junctions as well as POSIX symlinks where relevant.
- File only a reproducible still-open boundary issue.

## C — Bounded structured logging / safe telemetry

### Potential value

Workbridge persists bounded tool-usage and lifecycle telemetry for operational diagnosis. Some pieces may be useful upstream when they improve debugging without collecting sensitive payloads or materially increasing runtime complexity.

### Recommendation

Do not upstream Workbridge's full telemetry system. Extract only specific events or fields that support a demonstrated DevSpace diagnostic need.

## C — Text-corruption / mojibake detection

### Potential value

Windows command output and multi-layer transport paths can occasionally surface encoding corruption. Detecting obvious corruption can make failures easier to diagnose.

### Recommendation

Only pursue when there is a reproducible DevSpace case. Avoid broad output normalization that could alter legitimate command output.

## C — Modern MCP per-request registration overhead

### Observation

The MCP 2026-07-28 handler creates a fresh server instance per request and registers the tool/resource surface for that request. This follows the MCP v2 per-request factory model, so it is not by itself a correctness defect.

### Possible optimization

Immutable tool/resource/schema definitions might be reusable while preserving a fresh per-request server instance.

### Why optimization is deferred

The request factory model is intentional, and sharing one mutable server across requests would violate the lifecycle assumptions of the installed MCP 2026-07-28 server package. A custom registration cache or definition layer would add complexity and could duplicate future SDK optimizations.

### 2026-08-17 local measurement

The current modern Workbridge construction path was microbenchmarked with the Codex tool surface, widgets disabled, and the same shared workspace/review/process managers used by the real server. The benchmark measured only `createModernMcpServerAdapter()` plus `createMcpServer()` tool registration for 500 fresh request servers; it did not include network, OAuth, tool execution, or response transport time.

| Metric | Time |
|---|---:|
| Average | 5.773 ms |
| p50 | 4.650 ms |
| p95 | 14.569 ms |
| p99 | 16.923 ms |
| Max | 20.827 ms |

The fixed cost is therefore measurable, especially relative to very small local reads, but is still small compared with many real tool executions and host/model latency. Treat it as an optimization candidate rather than a correctness issue.

### Next step

Benchmark first:

- server creation + registration latency (baseline measured above; preserve it for before/after comparisons);
- `tools/list` / `resources/list` latency;
- scaling as registered tool count grows;
- CPU/allocation cost under repeated modern MCP requests.

Optimize only if registration is a material share of end-to-end request cost. Prefer an SDK-supported immutable-definition/registration optimization; do not reuse mutable per-request server state merely to eliminate the measured setup time.

## Deferred because of likely upstream overlap

Do not prioritize these until current upstream work is checked:

- workspace reuse / bootstrap behavior;
- generic startup/doctor diagnostics;
- client-access policy / denylist behavior;
- broad MCP session lifecycle refactors.

## Not suitable for upstream without a separate product decision

These are currently Workbridge-specific and should not be bundled into generic DevSpace PRs:

- Aegis Gate / Alpha Observatory-specific workspace actions;
- Workbridge Session Monitor / Electron UI;
- Graft/Serena orchestration policy;
- Workbridge branding and downstream-only configuration policy;
- Workbridge-specific monitoring/telemetry UI;
- downstream rebase-management behavior.

## Recommended investigation order

1. Child-process environment hardening.
2. Concrete absolute-path disclosure surfaces.
3. HTTP/MCP disconnect classification.
4. Re-check realpath/junction delta against current upstream.
5. Re-check MCP session hardening after overlapping upstream work settles.
6. Benchmark modern MCP registration overhead before any optimization.

## Maintenance rule for this ledger

Before starting any candidate:

1. fetch current `upstream/main`;
2. inspect open/merged upstream PRs for overlap;
3. compare the current Workbridge implementation against upstream rather than assuming the old delta still exists;
4. keep the candidate as a single coherent PR;
5. verify the real DevSpace consumption path, not only unit tests;
6. update this document with the result: filed, merged, rejected, obsolete, or deferred.
