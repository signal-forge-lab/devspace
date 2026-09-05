# Workbridge Tauri Monitor Design

Date: 2026-08-24
Status: accepted / Tauri primary on Windows since 2026-08-30

## 1. Goal

Migrate the Workbridge Desktop Monitor shell from Electron to Tauri + Rust + WebView2 while preserving the current Session Monitor UI and Node-based Workbridge server.

Primary reason: reduce desktop-monitor RAM usage without reducing observability or control capability.

This is a shell migration, not a server rewrite and not a UI rewrite.

## 2. Canonical architecture

- Workbridge server remains Node.js.
- Existing `/monitor` web UI remains the single canonical UI.
- Tauri is the canonical primary desktop shell on Windows.
- Electron is retained only as a temporary fallback until Tauri completes a
  user-accepted period of stable normal operation, then the Electron-specific
  shell is removed.
- Tauri host is Rust.
- Windows web rendering is WebView2.
- Runtime-specific behavior must be isolated behind a small adapter instead of forking the UI.
- Windows is the only required platform for this phase.

## 3. Migration sequence

### Phase 0 — Electron observability prerequisite

- Keep the existing approximately 5-second Electron memory sample.
- Persist Memory Log v1 every 30 seconds from that existing sample.
- Add UTC daily rotation, 30-day retention, non-fatal logger health, and compact History UI.
- Complete packaged Electron live verification before Tauri implementation becomes the comparison target.

### Phase 1 — Tauri shell skeleton

1. Create `desktop/monitor-tauri`.
2. Pin Tauri 2.11.x rather than an unconstrained major.
3. Build a packaged Windows window.
4. Reuse Workbridge project-root discovery rules.
5. Load the existing `/monitor` UI; do not copy its HTML/TypeScript.
6. Introduce a minimal runtime adapter boundary for Electron/Tauri host-specific capabilities.

### Phase 2 — read-only parity

- Status, startup configuration and memory information are visible.
- Tauri emits the same logical Memory Log v1.
- No control write-path parity is required until read-only behavior is stable.

### Phase 3 — control parity

- Start / Stop / Restart.
- Build / Build & Restart.
- Pause / Resume.
- Save Startup Config.
- Preserve the existing safety and ownership rules.

### Phase 4 — packaging and operations

- Packaged Windows app.
- Normal launcher/start-menu flow.
- No visible console dependency.
- Restore/relaunch behavior equivalent to the Electron monitor where applicable.

### Phase 5 — A/B validation

Compare Electron and Tauri under equivalent workload:
- startup,
- idle,
- multiple sessions,
- populated activity log,
- at least 30 minutes of steady operation.

Completed 2026-08-30. After the Activity Log DOM-retention fix (`6de41b5`), the
accepted long-run samples were:

- Tauri: 25.62 hours / 3,066 samples / Private median 590.7 MiB / p95 640.8 MiB /
  max 732.7 MiB / long-run slope about +0.6 MiB/hour.
- Electron: 18.79 hours / 2,236 samples / Private median 695.4 MiB / p95
  1,162.6 MiB / max 1,185.2 MiB.
- Both shells stayed bounded after the shared UI leak fix; Tauri had the better
  long-tail and peak private-memory behavior.

### Phase 6 — default switch

Tauri becomes default only after functional parity, safety checks, packaging validation and RAM comparison are accepted.

Completed 2026-08-30. `npm run monitor:launch` is the canonical launch command
and resolves to the Tauri launcher. `monitor:desktop:*` remains explicit fallback
surface only.

### Phase 7 — Electron retirement

Pending intentionally.

After the user accepts Tauri as stable through normal primary operation:

1. Remove Electron-specific runtime/package/installer/launcher code and Electron
   dependencies and commands.
2. Remove Electron-only documentation and tests.
3. Preserve or relocate shared `desktop/monitor` supervisor, library, and
   memory-log code still consumed by Tauri before deleting any directory.
4. Re-run Tauri control, recovery, memory logging, Secure Tunnel ensure, and
   full `verify:rebase` gates after the cleanup.

Do not leave Electron as an indefinite second implementation once the stability
gate is accepted.

### Phase 8 — Rust control-plane consolidation

Planned to coincide with, or immediately precede, Electron retirement. This is
primarily a simplification and ownership cleanup, not a RAM-performance project.

The current Tauri host already owns Windows process enumeration/termination,
desktop memory telemetry and Memory Log v1 persistence, startup-config reading,
runtime-status shaping, residual-process detection, and Tauri command handling.
The remaining significant Node dependency in the Tauri shell is the control path:

```text
Tauri / Rust
  -> run_monitor_action / save_startup_config
  -> node desktop/monitor-tauri/tauri-control.cjs
  -> desktop/monitor/supervisor.cjs
  -> Start / Stop / Restart / Build / Build & Restart / Pause / Resume
```

The target is to move only that Monitor control-plane behavior into the existing
Rust host, then remove `tauri-control.cjs` and the Electron-oriented supervisor
code once the fallback shell is retired. Preserve the existing safety contracts:

- managed-process ownership and control-token behavior,
- bounded Start/Stop/Restart and residual-process handling,
- startup wait and shutdown wait semantics,
- Build and Build & Restart behavior,
- Pause / Resume behavior,
- Startup Config validation and persistence,
- Monitor action logging,
- Secure Tunnel `ensure` after a successful managed start,
- current fail-closed behavior for external/unowned processes.

Do not broaden this into a Workbridge server rewrite. The Node.js MCP server,
shared `/monitor` web UI, Secure Tunnel PowerShell helper, and detached Tauri
launcher remain in their current languages unless a separate measured problem
justifies changing them. In particular, rewriting the MCP server or web UI in
Rust is explicitly out of scope for this consolidation.

Recommended sequence:

1. Stabilize Tauri as the normal primary Monitor.
2. Port the Tauri-only control path from `tauri-control.cjs` /
   `supervisor.cjs` into `monitor_host.rs` using the existing Rust process and
   state primitives.
3. Prove parity for Start, Stop, Restart, Build, Build & Restart, Pause, Resume,
   Startup Config, residual-process recovery, action logging, and Secure Tunnel
   ensure.
4. Remove `tauri-control.cjs`.
5. Retire the Electron shell and remove Electron-only supervisor/package/runtime
   code, preserving any still-shared contracts until their Rust replacement is
   verified.
6. Run Tauri live-control validation and full `verify:rebase` after cleanup.

Expected benefit: fewer runtime boundaries and temporary Node helper launches,
less duplicated lifecycle logic, and a clean Tauri-only Monitor implementation.
Do not treat this as a reason to add new abstractions or dependencies.

## 4. Memory Log v1

Logical schema identifier:

 `workbridge.monitor.memory.v1`

Required behavior:
- source sample cadence remains about 5 seconds,
- persistence cadence is 30 seconds,
- UTC daily JSONL rotation,
- 30-day retention,
- append-only writes,
- ordered writes,
- cleanup/append failures are non-fatal to monitor operation,
- logger health is surfaced to the UI,
- Electron and Tauri use the same logical record shape.

Never persist:
- prompt text,
- response text,
- tool content,
- authentication material,
- access tokens,
- session titles,
- arbitrary runtime payloads.

Only explicitly selected telemetry fields may enter the record.

For post-Phase-5 Modern MCP bottleneck analysis, Memory Log v1 also persists an
additive, allowlisted performance snapshot every 30 seconds:

- `modernMcp.requests`, `active`, and `peakActiveRequests`,
- `modernMcp.registrationMs`, `handlerMs`, and `totalMs` with count/p50/p95/p99,
- `nodeSaturation.eventLoopUtilization`,
- `nodeSaturation.eventLoopDelayP50Ms`, `eventLoopDelayP95Ms`, and
  `eventLoopDelayP99Ms`,
- `nodeSaturation.sampleWindowMs`.

This is intentionally aggregate-only telemetry. Do not persist request IDs,
tool arguments/content, prompt/response text, arbitrary errors, client metadata,
or other runtime payloads through this path. The purpose is to make long-run
Phase 6 bottleneck comparisons possible without increasing sensitive-data
retention.

## 5. Fair memory comparison boundary

Electron total:
- Browser/Main,
- Renderer,
- GPU,
- Utility,
- other attributable Electron children.

Tauri total:
- Rust host,
- attributable WebView2 descendant processes.

Do not compare only the Rust host against the full Electron process tree.

Record:
- working set,
- private bytes when available,
- process-role breakdown,
- system total/free/used RAM,
- server RSS/heap as contextual workload data,
- current Workbridge branch/commit/dirty state,
- active request counts,
- aggregate Modern MCP phase timings and Node event-loop saturation.

## 6. Runtime adapter

The shared UI must not know implementation details of Electron IPC or Tauri commands.

Target conceptual surface:
- `getStatus()`
- `onStatus(listener)`
- later: `runAction(action)`
- later: `saveStartupConfig(config)`

Electron may implement the adapter through preload/IPC. Tauri may implement it through Rust/Tauri invoke/event mechanisms. The UI behavior and data contract remain shared.

## 7. Root discovery and server ownership

Tauri must not start a second Workbridge server merely to render the monitor.

Project-root resolution should honor:
1. explicit `WORKBRIDGE_PROJECT_ROOT` when valid,
2. current executable/app/cwd ancestor candidates,
3. the same Workbridge-root validity rules used by the Electron monitor where practical.

The monitor URL remains loopback-only by default and should follow the existing server/monitor configuration.

## 8. Security and failure rules

- Do not weaken existing navigation restrictions.
- Do not expose filesystem or shell primitives directly to the web UI.
- Host commands must be bounded to defined monitor capabilities.
- Memory logging failures must not stop monitoring or Workbridge.
- No remote publish/push is part of this migration.
- Preserve startup-config and process-ownership safety semantics.

## 9. Phase 1 acceptance criteria

Phase 1 is complete when:
- `desktop/monitor-tauri` exists in the canonical repository,
- Tauri/Rust dependencies are explicitly pinned to a compatible 2.11.x line,
- the Windows shell builds successfully on the current machine,
- a packaged or production-mode Tauri window can load the existing Workbridge monitor UI,
- project-root/monitor URL resolution is bounded and tested,
- a minimal host adapter boundary exists,
- no duplicate Session Monitor UI has been introduced,
- Electron remains operational as fallback.

## 10. Canonical source policy

The current `workbridge-fixed-surface` history and implementation are authoritative. If this document ever conflicts with canonical behavior or later verified requirements, update this document rather than reverting known-good canonical behavior.

Source changes are developed in dedicated worktrees, integrated atomically, and pushed only when the user explicitly requests remote publication.
