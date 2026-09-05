# Workbridge internal improvement candidates

Date: 2026-08-17

This ledger tracks Workbridge-specific improvements observed during real use.
It is separate from the Workbridge → DevSpace upstream candidate ledger because
several items concern the downstream Session Monitor or local operating model.

| Priority | Candidate | Evidence / reason | Next step |
|---|---|---|---|
| Implemented | Explicit Soft Pause resume | Real use required manually removing `soft-pause.json`; `SoftPauseController.clear()` already existed | `control resume` and the Session Monitor Resume action now use the existing clear primitive; restart still clears a pending pause implicitly |
| Implemented | Runtime build identity in Session Monitor | Runtime status exposed version/PID but not the exact worktree commit, making version verification indirect | Runtime status now exposes source root, branch, commit and dirty state; the Monitor shows the build row and warns when its managed project root differs from the running server source root |
| Implemented | Isolate `desktop/monitor/supervisor.test.cjs` from live runtime state | Full test could ingest live Workbridge startup configuration and fail depending on the machine state | The standalone test now removes Startup Config environment variables before constructing supervisors; an injected live-style environment regression check passes |
| Implemented | Configuration provenance in Session Monitor | OAuth/state troubleshooting required manually determining whether env/config/auth files supplied the effective value | Runtime status now exposes source labels only (never secret values), and Monitor startup state records whether fields came from saved Monitor state, Monitor environment, or an adopted runtime |
| Implemented | Serena managed-worktree checkout resolution | Live `run_semantic_action health` failed with `spawn git ENOENT` because the default Serena cwd resolved beside the managed worktree root, where no Serena checkout existed | Managed worktrees now resolve the canonical checkout through Git's common directory and use its sibling Serena checkout; live health and semantic queries pass |
| Implemented | Managed worktree / branch hygiene gate | Completed worktrees and stale local branches accumulated across maintenance sessions and obscured which work was still active | `maintenance:worktrees` classifies managed worktrees and local branches without deleting them; `verify:rebase` rejects already-integrated worktrees and unprotected integrated branches, while detached or unique history can be preserved under local archive refs before cleanup |
| Implemented | Make Monitor startup progress explicit | A normal startup wait appeared indistinguishable from a hung launch because the waiting page showed only raw `starting` / `Starting Workbridge…` text | The waiting page now uses human-readable operation labels and shows elapsed seconds while an operation is active |
| Implemented | Diagnose Serena generated-environment upgrade failures | Upgrading Serena v1.6.1 → v1.7.0 failed when Windows read-only/access state prevented `uv` from replacing generated `.venv` metadata | Startup stderr is inspected only on connection failure; the known `.venv` access-denied signature now produces an actionable cleanup/retry message without auto-deleting the environment |
| B | Harden Serena initialization against broad workspace roots and transient ignore-scan `FileNotFoundError` | A workspace opened at the broad `Intelligence Works` root failed Serena project initialization when `.gitignore` traversal reached a `node_modules` directory that disappeared mid-scan; ignore-spec creation aborted, `LanguageServerManager` was never created, and semantic actions then failed even though Serena itself was healthy | Reproduce with an exact disappearing-path fixture; evaluate one bounded project-initialization retry/reconnect plus an actionable hint to open the exact repo/worktree root. Do not silently broaden/narrow the workspace or swallow arbitrary filesystem errors |
| Closed / reverted | Reduce successful `/mcp` HTTP log noise | Every successful tool call produces both `tool_call` and `http_request POST /mcp 200` | User prefers raw HTTP visibility; successful `/mcp` rows remain visible in the default ALL view. Successful Monitor self-polls and static assets remain separately suppressed at log-generation time |
| B | Keep synchronous structured logging bounded | A normal modern tool call can synchronously append four log records (modern probe, tool-usage telemetry, tool-call event, HTTP request) | Keep as an operability tradeoff unless profiling shows event-loop stalls; prefer batching/streaming only with equivalent shutdown/error guarantees |
| Implemented / deferred | Modern MCP per-request request-phase measurement and registration overhead | MCP 2026-07-28 creates a fresh server per request and Workbridge registers its tool surface each time | Request phases are now measured; direct registration optimization was prototyped but deferred because a safe narrow cache did not materially improve tail latency and broader optimization requires restructuring `createMcpServer()` |

## Modern MCP per-request registration measurement

Current Workbridge follows the MCP 2026-07-28 server package's per-request
factory model. For each modern request the Workbridge factory currently performs:

```text
createModernMcpServerAdapter()
  -> createMcpServer()
     -> register Workbridge/upstream tool definitions and handlers
  -> handle one modern MCP request
```

A local microbenchmark on 2026-08-17 used the current Workbridge Codex tool
surface, widgets off, shared workspace/review/process managers (matching the
runtime ownership model), and measured only modern server creation plus tool
registration over 500 iterations:

| Metric | Time |
|---|---:|
| Average | 5.773 ms |
| p50 | 4.650 ms |
| p95 | 14.569 ms |
| p99 | 16.923 ms |
| Max | 20.827 ms |

This confirms a real fixed cost, but does **not** justify sharing one mutable
`McpServer` across requests. The installed MCP server implementation explicitly
uses modern per-request instances and closes request products according to that
lifecycle.

Potential optimization work should therefore preserve a fresh request server
and target only immutable/repeatable setup, for example precomputed descriptor
data or another SDK-supported registration shortcut. Do not build a custom
transport or cache mutable request/server state solely to save a few
milliseconds.

### 2026-08-17 optimization probe

The server constructor itself was separated from Workbridge registration in a
300-iteration benchmark:

| Path | Average | p50 | p95 | p99 |
|---|---:|---:|---:|---:|
| Modern `McpServer` adapter only | 0.008 ms | 0.005 ms | 0.017 ms | 0.047 ms |
| Full Workbridge registration | 6.041 ms | 4.506 ms | 15.410 ms | 19.684 ms |

This shows that the request server object itself is effectively free and the
fixed cost lives in Workbridge tool definition/schema/handler setup.

A prototype cached the first Standard Schema conversion per tool while keeping
a fresh request server and delegating validation to the original schema. It
reduced p50 setup from about 4.51 ms to about 3.76 ms in one run, but p95 stayed
approximately unchanged (15.41 ms versus 15.49 ms). Filtering registration to
one requested tool and even making the registrar a no-op did not materially
remove the remaining setup time. The work is therefore spread through
`createMcpServer()` definition/closure construction rather than one cacheable
SDK call.

The prototype was removed. A meaningful Phase 3 optimization would require a
larger separation between immutable tool definitions and per-request handler
binding. That is a wider upstream-owned `server.ts` change with rebase and
contract risk, so it remains deferred until production phase timings show that
the fixed setup cost is important enough to justify that architecture work.

### Implemented phase timing

Modern request metrics now retain the recent request breakdown for:

- bearer authentication;
- modern/legacy request conversion and classification;
- per-request Workbridge server/tool registration;
- modern handler execution;
- total `/mcp` route time.

The Session Monitor shows total and registration timing for recent modern
requests; the runtime status retains all measured phase values for diagnosis.

Before implementing an optimization, measure end-to-end real-host impact. The
observed Workbridge logs commonly show roughly 10–20 ms between very small tool
execution time and full `/mcp` request completion, so server/registration cost is
only one part of the wrapper cost; OAuth verification, request conversion,
classification, logging, tunnel/client behavior, and response adaptation also
contribute.

## Activity Log current policy

One modern tool call normally yields multiple valid observability events:

```text
mcp_modern_probe_detected
tool_call
http_request POST /mcp 200
```

The default ALL view intentionally shows all three, including successful
`http_request POST /mcp 200`, because the operator prefers transport visibility.
Noise suppression remains limited to communication that is generated by the
Monitor itself or is static delivery rather than MCP work: successful
`GET /monitor/api/status`, successful `GET /monitor/api/snapshot`, and static
`/mcp-app-assets/*` requests when asset logging is disabled.

## Serena managed-worktree `ENOENT` resolution

The incident was confirmed not to be a Git-PATH defect. Investigation found:

- normal Workbridge `exec_command` resolves Git successfully;
- Node `execFile("git", ["--version"])` succeeds in the normal command path;
- the live managed-worktree server resolved its default Serena directory to
  `<managed-worktree-root>/serena`, which did not exist;
- the actual sibling Serena checkout beside the canonical Workbridge checkout
  existed and matched the required pinned revision;
- reproducing `execFile("git", ...)` with the missing directory as `cwd`
  produced the same `spawn git ENOENT` error.

The fix preserves `WORKBRIDGE_SERENA_DIR` as the explicit override and normal
checkout sibling behavior. When that sibling is absent in a managed Git
worktree, Workbridge resolves Git's common directory, derives the canonical
checkout, and uses the Serena checkout beside it. After rebuilding and managed
restarting the live server, `run_semantic_action health` and a real
`find_symbol` query both succeeded.

## Serena broad-root / transient ignore-scan initialization hardening candidate

A separate 2026-09-05 incident showed a different failure mode from the
managed-worktree `ENOENT` case above. Serena itself and its pinned checkout were
healthy, but the Workbridge workspace had been opened at the broad
`C:\Users\shogo\Documents\Intelligence Works` root instead of the exact target
repository/worktree. During Serena project activation, `.gitignore`/ignore-spec
collection traversed a high-churn dependency tree and reached
`tools\dsh-workflow-iw\node_modules\@deepseek-ai\cordis` after that directory had
disappeared. The resulting `FileNotFoundError [WinError 3]` aborted project
initialization before `LanguageServerManager` was created, so later
`find_symbol` / `get_diagnostics_for_file` calls failed even though the Serena
subprocess health surface could still respond.

Opening the exact DSH repository/worktree as a new Workbridge workspace and
reusing that workspace id restored `health`, symbol overview, and diagnostics.
This confirms that the immediate operating rule should remain: Serena project
root equals the exact opened workspace, and callers should open the actual
repo/worktree rather than a broad allowed-root umbrella when doing semantic
work.

Future hardening should be evaluated narrowly. Add a regression fixture where
an ignored directory disappears during project initialization, then determine
whether Workbridge should perform one bounded Serena project reconnect/retry and
surface a specific "open the exact repo/worktree" hint when initialization
fails in this pattern. Do not silently substitute a different project root and
do not blanket-ignore `FileNotFoundError`; both would hide real containment or
repository problems.

## Structured logging cost measurement

Workbridge file logging currently uses synchronous `appendFileSync`. A normal
successful modern tool call can write four records when the corresponding
features are enabled:

1. `mcp_modern_probe_detected` to the primary JSONL log;
2. safe tool-usage telemetry to its bounded JSONL log;
3. `tool_call` to the primary JSONL log;
4. `http_request` to the primary JSONL log.

A local 2026-08-17 microbenchmark of four same-sized synchronous appends per
iteration over 2,000 iterations measured:

| Metric | Time for four appends |
|---|---:|
| Average | 0.5120 ms |
| p50 | 0.4867 ms |
| p95 | 0.6726 ms |
| p99 | 0.8201 ms |
| Max | 1.4154 ms |

On this machine the synchronous file writes are measurable but much smaller
than modern server/tool registration. Do not replace them with a buffered
logging subsystem solely for performance without first demonstrating an
event-loop or throughput problem; synchronous persistence currently keeps
failure behavior simple and predictable.
