# Workbridge Modern MCP Concurrency Benchmark — 2026-09-04

## Status

**Decision record: complete. No immediate Modern MCP performance architecture change is recommended.**

This document closes the measurement work originally described in
`WORKBRIDGE_MODERN_MCP_CONCURRENCY_PERF_HANDOFF_20260828` by recording the
current canonical implementation, a fresh benchmark run on the current HEAD,
and the resulting architecture decision.

The benchmark is intended to answer a practical question: how far the current
single Workbridge Node.js process benefits from additional concurrent Modern MCP
requests before throughput stops improving and latency starts increasing.

It is not a capacity guarantee for every tool or machine. Tool handlers have
very different I/O and execution characteristics, so these numbers are a local
baseline and an architecture decision input.

## Canonical implementation

Measured canonical checkout:

```text
branch: workbridge-fixed-surface
commit: f9a09edb38b4260ca0496f7d40554a789fa57715
version: 1.0.7-workbridge.1
```

The planned concurrency observability is already integrated in canonical HEAD.
Relevant integrated commits include:

```text
c40794b feat: add modern MCP concurrency observability
d30067e feat: add isolated modern MCP concurrency benchmark
7ff73df feat: expose modern MCP saturation in monitor
f5b8149 fix(mcp): stabilize concurrency benchmark sampling
```

Current implementation includes:

- Modern MCP active/peak request counters.
- Active/peak registration counters.
- Active/peak handler counters.
- Completed/success/error request counts.
- Per-request concurrency-at-start and overlap information.
- `authMs`, `classifyMs`, `registrationMs`, `handlerMs`, and `totalMs` phase timings.
- Node.js event-loop utilization and event-loop delay telemetry.
- Session Monitor visibility for Modern MCP concurrency and Node saturation.
- An isolated read-only benchmark at `scripts/benchmark-modern-mcp-concurrency.mjs`.

## Environment

```text
Date:               2026-09-04
OS:                 Microsoft Windows 11 Pro
OS version/build:   10.0.26200 / 26200
CPU:                AMD Ryzen 7 7840HS with Radeon 780M Graphics
Logical processors: 16
Node.js:             v24.16.0
Workbridge branch:  workbridge-fixed-surface
Workbridge commit:  f9a09edb38b4260ca0496f7d40554a789fa57715
```

## Benchmark command

The benchmark runs an isolated Workbridge child process and uses only read-only
Modern MCP requests. It creates temporary configuration/state/project
directories and removes them afterward.

The complete concurrency range is 1, 2, 4, 8, 16, and 32. The measurements in
this document were collected in two passes during the same review using the
same benchmark implementation and current HEAD.

Representative command:

```text
npm run benchmark:modern-mcp:concurrency -- --mode both --concurrency 1,2,4,8,16,32 --iterations 5 --min-duration-ms 1000
```

The benchmark itself enforces a minimum measured duration based on the Node
saturation sampling window, so the effective duration can be longer than the
CLI minimum.

## Scenario A — `tools/list`

This scenario emphasizes MCP/server overhead rather than a meaningful external
tool operation.

| Concurrency | Throughput req/s | Client p50 ms | Client p95 ms | Client p99 ms | Registration p50 ms | Server total p50 ms | ELU avg | ELU peak | Loop delay p95 ms |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 128.329 | 7.188 | 10.106 | 14.283 | 2.091 | 5.796 | 0.863 | 0.870 | 26.591 |
| 2 | 140.683 | 10.390 | 16.194 | 19.213 | 2.249 | 5.883 | 0.938 | 0.946 | 28.131 |
| 4 | 137.227 | 18.063 | 30.115 | 50.955 | 2.331 | 6.129 | 0.972 | 0.981 | 34.931 |
| 8 | 142.725 | 31.180 | 56.645 | 96.373 | 2.345 | 5.981 | 0.982 | 0.988 | 76.153 |
| 16 | 132.021 | 65.176 | 126.546 | 189.729 | 2.510 | 6.490 | 0.980 | 0.984 | 159.252 |
| 32 | 135.143 | 126.634 | 226.386 | 282.842 | 2.571 | 6.560 | 0.985 | 0.991 | 256.901 |

Observed server-side peak active request/handler/registration counts remained
1 in this lightweight scenario. Client-side concurrent submissions therefore
queue around synchronous/event-loop work rather than becoming useful parallel
server-side execution.

### `tools/list` interpretation

- Throughput improves only modestly from concurrency 1 to 2.
- Throughput is effectively flat from concurrency 2 through 32.
- Client p95 grows from about 10 ms at concurrency 1 to about 226 ms at 32.
- ELU is already about 0.86 at concurrency 1 and reaches about 0.99 at 32.
- Event-loop delay grows sharply at high client concurrency.
- Registration p50 stays near 2-3 ms instead of growing with concurrency.

For CPU/event-loop-heavy lightweight MCP work, extra client concurrency mostly
adds queueing latency after a very small throughput gain.

## Scenario B — `read`

This scenario includes a real Workbridge read-only tool handler and therefore
allows logical requests to overlap while awaiting work.

| Concurrency | Throughput req/s | Client p50 ms | Client p95 ms | Client p99 ms | Registration p50 ms | Handler p50 ms | Server total p50 ms | Peak active requests | ELU avg | Loop delay p95 ms |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 101.164 | 8.933 | 12.551 | 20.732 | 2.218 | 7.215 | 7.733 | 1 | 0.740 | 25.608 |
| 2 | 125.649 | 14.016 | 18.961 | 31.506 | 2.283 | 10.408 | 10.861 | 2 | 0.867 | 26.329 |
| 4 | 151.184 | 23.158 | 30.951 | 139.103 | 2.183 | 15.583 | 16.107 | 4 | 0.915 | 31.293 |
| 8 | 145.572 | 48.359 | 63.797 | 185.852 | 2.301 | 30.937 | 31.480 | 8 | 0.907 | 61.440 |
| 16 | 126.929 | 109.294 | 275.660 | 302.511 | 2.591 | 67.950 | 68.321 | 16 | 0.917 | 118.227 |
| 32 | 130.348 | 216.957 | 390.023 | 402.550 | 2.514 | 131.778 | 132.359 | 32 | 0.910 | 189.792 |

Peak active handlers followed peak active requests for this scenario while
peak active registrations remained 1.

### `read` interpretation

- Throughput scales usefully from concurrency 1 through 4.
- The best measured throughput is at concurrency 4: about 151 req/s.
- Increasing concurrency from 4 to 8 does not improve throughput and roughly
  doubles client p95 latency.
- Concurrency 16 and 32 materially reduce throughput relative to 4 while
  increasing latency by an order of magnitude from the low-concurrency case.
- Registration p50 remains about 2.2-2.6 ms across the entire range.
- Handler latency, client latency, and event-loop delay grow under high
  concurrency; registration does not show comparable growth.

For this read-only workload, **concurrency around 4 is the practical local
sweet spot**. This is a measurement result, not a server-enforced limit.

## Live runtime observation

The canonical Workbridge runtime was also inspected outside the isolated
benchmark. At inspection time it had processed more than 18,000 Modern MCP
requests without recorded Modern MCP request errors and had observed a peak of
4 active Modern MCP requests.

Recent real requests showed registration commonly around 2-3 ms, while actual
handlers ranged from a few milliseconds for `read` to seconds for commands or
process polling. This reinforces the benchmark conclusion that registration is
not currently the dominant cost in normal Workbridge use.

The runtime values are observational and continue to change; they are not a
fixed acceptance baseline.

## Architecture decision

### Registration optimization: not recommended now

The historical concern was that each Modern MCP request creates a fresh server
and re-registers the tool surface. Prior experiments showed that server object
construction itself is negligible and that registration/schema/closure setup
costs several milliseconds.

The current benchmark does not show registration becoming the scaling
bottleneck:

- registration p50 remains near 2-3 ms at concurrency 1 through 32;
- high-concurrency degradation appears primarily in handler/client latency and
  event-loop delay;
- real Workbridge handlers frequently cost much more than registration.

Therefore no immutable tool-definition architecture, expanded schema cache, or
shared `McpServer` design should be introduced solely from the current data.

### Multi-tunnel: not recommended

Multiple tunnels feeding the same Node.js Workbridge process do not increase
the event-loop execution capacity measured here. They would add configuration
and routing complexity without addressing the observed bottleneck.

### Multi-process / dispatcher: defer

True horizontal scaling would require multiple worker processes rather than
multiple tunnels alone. That also requires a deliberate design for shared
application state, including workspace state, process sessions, review
checkpoints, and locking semantics.

The current workload and runtime observation do not justify that complexity.

### Hard concurrency limit: not recommended

Do not hard-code a global concurrency limit of 4 from this benchmark. Different
handlers have different I/O characteristics, and current production-like
runtime observation has not demonstrated an overload problem that requires a
server-side semaphore.

Concurrency 4 should be treated as the best point measured for this local
`read` benchmark, not as a protocol or product contract.

## Relationship to Code Intelligence telemetry

`code-intel-telemetry-completion` is a separate, currently active implementation
effort. It measures Code Intelligence operations/providers, while the telemetry
described here measures the Modern MCP request/server layer.

Do not add competing Modern MCP architecture changes while that work is still
being integrated unless a concrete defect requires it.

Once Code Intelligence telemetry is complete, the useful next analysis is to
correlate the two layers:

```text
Modern MCP
  registrationMs
  handlerMs
  concurrency
  event-loop saturation

with

Code Intelligence
  provider / operation
  latency
  success / failure
  fallback
```

This makes it possible to distinguish a slow underlying Code Intelligence
operation from overhead inside Workbridge's MCP layer before choosing an
optimization target.

## Re-evaluation triggers

Re-open the performance architecture decision only when one or more of the
following becomes true:

1. Normal Workbridge runtime repeatedly sustains concurrency above the current
   practical range and users observe material queueing/latency problems.
2. Modern MCP registration grows enough to become a material share of real
   handler latency or clearly limits throughput.
3. Code Intelligence telemetry shows fast underlying provider operations but
   disproportionately slow Workbridge handler/transport time.
4. A real workload demonstrates that one process cannot meet required
   throughput even after tool-specific bottlenecks are addressed.
5. There is a concrete product requirement for process isolation or horizontal
   scaling independent of raw benchmark throughput.

If none of these triggers exists, prefer the current single-process design.

## Current recommendation

```text
Modern MCP concurrency observability: complete and integrated
Event-loop observability:           complete and integrated
Local concurrency benchmark:        complete and reproducible
Monitor visibility:                 complete and integrated

Practical read concurrency:         approximately 4 on this machine/run
Registration optimization:          not recommended
Shared McpServer:                    not recommended
Multi-tunnel:                        not recommended
Multi-worker / dispatcher:           defer
Global concurrency semaphore:       not recommended

Next useful evidence:
complete Code Intelligence telemetry, then correlate both layers under normal use
```

No additional Modern MCP performance source-code change is justified by this
benchmark alone.
