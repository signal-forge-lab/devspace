# Workbridge Electron Monitor memory baseline

Date: 2026-08-24 (Asia/Tokyo)

This file is the comparison baseline for a future Tauri + WebView2 Monitor PoC.
Compare the complete desktop app process tree on both implementations rather
than comparing only the Electron browser process or only the Tauri Rust host.

## Measurement environment

```text
OS                 Microsoft Windows 11 Pro 10.0.26200 (build 26200)
Installed RAM      31,991,156,736 bytes (~29.8 GiB usable)
Workbridge         1.0.7-workbridge.1
Workbridge commit  2555e77cd575f292fd4f18d50f0b6221a1a0961c
Monitor            @workbridge/session-monitor-desktop 1.1.0
Electron           43.2.0
```

The packaged `Workbridge Monitor.exe` was measured. Desktop Working Set,
Private Bytes, and Peak come from the Monitor's `app.getAppMetrics()` process
tree aggregation. Workbridge RSS/heap come from `/monitor/api/status`. System
Free is the same system-memory source used by the Monitor.

For capture only, the packaged Monitor was relaunched with a temporary local
DevTools port so the preload-exposed Supervisor status could be read exactly.
The Workbridge server stayed running and was not restarted. The diagnostic
port is not part of normal runtime and must be removed after measurement.

## A. Startup — 30 seconds after Monitor launch

Capture: approximately 2026-08-24 00:53:36 +09:00.

| Metric | Display value | Raw bytes |
| --- | ---: | ---: |
| Desktop WS Current | 423.7 MiB | 444,289,024 |
| Desktop WS Peak | 423.7 MiB | 444,289,024 |
| Desktop Private | 327.5 MiB | 343,416,832 |
| Workbridge RSS | 353.0 MiB | 370,151,424 |
| Workbridge Heap | 96.8 MiB | 101,466,592 |
| System Free | 3.75 GiB | 4,030,148,608 |

Desktop process breakdown at the same sample:

| Electron process | WS | Private |
| --- | ---: | ---: |
| Browser | 102.8 MiB | 41.7 MiB |
| GPU | 120.5 MiB | 172.0 MiB |
| Utility | 43.0 MiB | 12.6 MiB |
| Renderer (Tab) | 157.4 MiB | 101.2 MiB |

The Monitor was freshly relaunched, but the existing Workbridge server and its
session/log history remained live. This is therefore a desktop-process startup
baseline, not a cold Workbridge-server startup measurement.

## C/D. Multiple sessions + populated Activity Log

Capture: 2026-08-24 00:56:28 +09:00 during real Workbridge use.

```text
Visible sessions       7
Visible tool calls     177
Session states         idle: 6, error: 1
Modern MCP requests    177 total, 0 active at capture
```

| Metric | Display value | Raw bytes |
| --- | ---: | ---: |
| Desktop WS Current | 425.1 MiB | 445,779,968 |
| Desktop WS Peak | 438.4 MiB | 459,685,888 |
| Desktop Private | 332.9 MiB | 349,085,696 |
| Workbridge RSS | 355.1 MiB | 372,318,208 |
| Workbridge Heap | 143.2 MiB | 150,147,072 |
| System Free | 3.90 GiB | 4,192,202,752 |

This is intentionally a real-workload point rather than a synthetic stress
test. It satisfies the comparison need for a Monitor with multiple sessions and
a materially populated Activity Log, but future Tauri comparison should replay
a similar session/log volume before treating the numbers as directly comparable.

## B. Idle 5 minutes

Capture: approximately 2026-08-24 00:59:48 +09:00, from the same packaged
Monitor process used for the startup sample.

| Metric | Display value | Raw bytes |
| --- | ---: | ---: |
| Desktop WS Current | 443.7 MiB | 465,301,504 |
| Desktop WS Peak | 452.6 MiB | 474,615,808 |
| Desktop Private | 360.3 MiB | 377,843,712 |
| Workbridge RSS | 226.6 MiB | 237,555,712 |
| Workbridge Heap | 98.4 MiB | 103,183,224 |
| System Free | 3.93 GiB | 4,215,345,152 |

There was no direct Monitor interaction during the five-minute interval, but
the Workbridge server was not quiet: Modern MCP requests increased from 161 at
the startup capture to 195 at this capture. Treat this as a realistic
"UI idle / background traffic present" point, not as a synthetic zero-traffic
idle measurement. If a future Tauri comparison needs a strict quiet-idle number,
repeat both implementations in a dedicated quiet window rather than comparing
against this sample silently.

## E. Long run

Capture: 2026-08-24 01:23:13 +09:00, 30.11 minutes after the packaged Monitor
process started. The same Electron process tree from the startup sample was
still running.

```text
Monitor PID            56052
Visible sessions       10
Visible tool calls     331
Session states         idle: 6, error: 3, running: 1
Modern MCP requests    330 total, 1 active at capture
```

| Metric | Display value | Raw bytes |
| --- | ---: | ---: |
| Desktop WS Current | 601.1 MiB | 630,329,344 |
| Desktop WS Peak | 605.5 MiB | 634,937,344 |
| Desktop Private | 532.8 MiB | 558,678,016 |
| Workbridge RSS | 292.9 MiB | 307,146,752 |
| Workbridge Heap | 154.3 MiB | 161,786,864 |
| System Free | 3.11 GiB | 3,344,281,600 |

Desktop process breakdown at the same sample:

| Electron process | WS | Private |
| --- | ---: | ---: |
| Browser | 100.1 MiB | 40.6 MiB |
| GPU | 121.8 MiB | 172.4 MiB |
| Utility | 34.6 MiB | 12.3 MiB |
| Renderer (Tab) | 344.7 MiB | 307.4 MiB |

Current Desktop WS increased from 423.7 MiB at the 30-second startup point to
601.1 MiB at 30 minutes. Most of that increase is in the Renderer (Tab), which
rose from 157.4 MiB to 344.7 MiB. This run was not a constant-workload leak
test: the Monitor accumulated substantially more live history while other
Workbridge activity continued, reaching 10 sessions / 331 visible calls and
330 Modern MCP requests. The result is therefore a real-use 30-minute baseline,
not evidence by itself of an Electron memory leak. A strict leak comparison
requires holding session/log volume and background traffic approximately
constant for both Electron and Tauri.

## Tauri comparison rule

Electron comparison unit:

```text
Browser/Main + Renderer + GPU + Utility + any other Electron child process
```

Tauri comparison unit:

```text
Tauri Rust host + every WebView2 child process attributable to the Monitor
```

For both implementations compare Total Working Set, Total Private Bytes, Peak
Working Set, Workbridge RSS/heap, and System Free under equivalent scenarios.
