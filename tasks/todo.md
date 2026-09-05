# Workbridge Modern MCP Phase 5

- [x] Re-audit canonical f5b8149 and current registration path
- [x] Capture unchanged before benchmark for all 12 cases
- [x] Add recording registrar and immutable compiled catalog
- [x] Add compile-once/bind-many and behavior regression tests
- [x] Switch only the Modern request path to startup catalog + fresh bind
- [x] Run targeted tests and tool baseline
- [x] Capture unchanged after benchmark for all 12 cases
- [x] Write before/after comparison
- [x] Run npm run verify:rebase
- [x] Complete correctness, security, and simplification self-review
- [x] Commit dedicated branch
- [x] Prepare reviewer handoff
- [x] Persist post-Phase-5 Modern MCP phase timings and Node saturation in the
  30-second Memory Log v1 so Phase 6 bottleneck analysis can use long-run data

## Checkpoint

- [x] Fresh Modern McpServer per request remains intact
- [x] No public tool-surface change
- [x] No canonical integration, live restart, or push

## Desktop Monitor lifecycle

- [x] Promote Tauri to the primary Windows Monitor after parity and long-run A/B validation
- [x] Make `npm run monitor:launch` resolve to the Tauri launcher
- [ ] After the user accepts a stable period of normal Tauri-primary operation,
  retire the Electron fallback. First preserve/relocate shared
  `desktop/monitor` supervisor/library/memory-log code used by Tauri, then remove
  Electron-specific runtime, packaging, dependencies, commands, docs, and tests.
- [ ] During or immediately before Electron retirement, consolidate the Tauri
  Monitor control plane into Rust: port the Tauri-used Start/Stop/Restart/Build/
  Build & Restart/Pause/Resume, Startup Config, residual-process, action-log, and
  Secure Tunnel ensure paths out of `tauri-control.cjs` / `supervisor.cjs`, then
  remove the temporary Node helper. Keep the Workbridge MCP server and shared
  `/monitor` UI in Node/TypeScript; do not expand this into a server/UI rewrite.
