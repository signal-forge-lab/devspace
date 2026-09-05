# Workbridge Windows / PowerShell Commands

This is the quick-reference for normal Workbridge operation on Windows.

Canonical checkout:

```powershell
Set-Location "C:\Users\shogo\Documents\Intelligence Works\github\workbridge"
```

Normal runtime branch:

```text
workbridge-fixed-surface
```

## Configuration model

Normal settings are stored in:

```text
~/.devspace/config.json
```

OAuth secrets stay separate in:

```text
~/.devspace/auth.json
```

The Desktop Monitor reads `config.json`. Saving Startup Config in the Monitor
writes back to `config.json` while preserving unrelated config fields.

Environment variables are temporary overrides for that launch only. They take
precedence over `config.json` but are not written back when the Monitor saves.

Effective priority:

```text
explicit environment override
  > ~/.devspace/config.json
  > built-in default
```

## Start Workbridge normally

The normal server command reads `config.json` automatically:

```powershell
Set-Location "C:\Users\shogo\Documents\Intelligence Works\github\workbridge"
node .\dist\cli.js serve
```

Equivalent npm command:

```powershell
Set-Location "C:\Users\shogo\Documents\Intelligence Works\github\workbridge"
npm start
```

## Start with a temporary override

Set only the values that should differ from `config.json` for this launch.

Example:

```powershell
Set-Location "C:\Users\shogo\Documents\Intelligence Works\github\workbridge"
$env:PORT = "7777"
node .\dist\cli.js serve
```

Example public URL override:

```powershell
Set-Location "C:\Users\shogo\Documents\Intelligence Works\github\workbridge"
$env:DEVSPACE_PUBLIC_BASE_URL = "https://example.example.net"
node .\dist\cli.js serve
```

Environment overrides are inherited by child processes in that PowerShell
session. Remove an override with `Remove-Item Env:NAME` or open a fresh shell.

## Start the Desktop Monitor independently from PowerShell

Recommended short command:

```powershell
Set-Location "C:\Users\shogo\Documents\Intelligence Works\github\workbridge"
npm run monitor:desktop:launch
```

The launcher uses Windows `Win32_Process.Create` internally. The Monitor is not
a child that depends on the PowerShell console remaining open.

## Start the packaged Monitor EXE directly

Explorer can launch this EXE directly:

```text
C:\Users\shogo\Documents\Intelligence Works\github\workbridge\desktop\monitor\release\Workbridge Monitor-win32-x64\Workbridge Monitor.exe
```

A Windows shortcut (`.lnk`) may be placed on the Desktop or in another folder.
The shortcut should point to the EXE above. Do not copy only the EXE away from
its packaged folder; Electron requires the neighboring packaged files.

## Start the source Electron Monitor

Development only:

```powershell
Set-Location "C:\Users\shogo\Documents\Intelligence Works\github\workbridge"
npm run monitor:desktop
```

This path is for Monitor development. For normal operation prefer the packaged
EXE or `npm run monitor:desktop:launch`.

## Rebuild the Monitor EXE

```powershell
Set-Location "C:\Users\shogo\Documents\Intelligence Works\github\workbridge"
npm run monitor:desktop:pack
```

## Build Workbridge

```powershell
Set-Location "C:\Users\shogo\Documents\Intelligence Works\github\workbridge"
npm run build
```

## Restart Workbridge and the Monitor

```powershell
Set-Location "C:\Users\shogo\Documents\Intelligence Works\github\workbridge"
node .\dist\cli.js control restart
```

## Soft pause controls

```powershell
Set-Location "C:\Users\shogo\Documents\Intelligence Works\github\workbridge"
node .\dist\cli.js control status
node .\dist\cli.js control pause --reason "maintenance"
node .\dist\cli.js control resume
```

## Health / runtime identity

Server health:

```powershell
Invoke-RestMethod "http://127.0.0.1:7676/healthz"
```

Monitor status:

```powershell
$status = Invoke-RestMethod "http://127.0.0.1:7677/monitor/api/status"
$status.server.buildIdentity
```

Expected normal source:

```text
sourceRoot = C:\Users\shogo\Documents\Intelligence Works\github\workbridge
branch     = workbridge-fixed-surface
dirty      = False
```

## Main optional environment overrides

| Variable | Purpose |
| --- | --- |
| `HOST` | Server bind host |
| `PORT` | MCP server port |
| `WORKBRIDGE_MONITOR_PORT` | local Monitor port |
| `DEVSPACE_CONFIG_DIR` | alternate directory containing config/auth files |
| `DEVSPACE_PUBLIC_BASE_URL` | public MCP origin |
| `DEVSPACE_ALLOWED_ROOTS` | project roots |
| `WORKBRIDGE_AUXILIARY_ROOTS` | auxiliary checkout roots |
| `DEVSPACE_WORKTREE_ROOT` | managed worktree destination |
| `DEVSPACE_STATE_DIR` | runtime state/log directory |
| `DEVSPACE_ALLOWED_HOSTS` | Host-header allowlist override |
| `DEVSPACE_TRUST_PROXY` | trust one reverse-proxy hop when `1` |

OAuth and logging variables are documented in `docs/configuration.md`. Normal
operation should keep secrets in `auth.json`, not in shell history.
