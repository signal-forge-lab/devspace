$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$exe = Join-Path $root "desktop\monitor-tauri\src-tauri\target\release\workbridge-monitor-tauri.exe"
$cwd = Split-Path -Parent $exe

if (-not (Test-Path -LiteralPath $exe)) {
    Write-Host "Workbridge Tauri Monitor executable was not found. Building it first..."
    Push-Location $root
    try {
        & npm.cmd ci --prefix desktop/monitor-tauri
        if ($LASTEXITCODE -ne 0) { throw "Failed to install Workbridge Tauri Monitor build dependencies." }
        & npm.cmd run build:win --prefix desktop/monitor-tauri
        if ($LASTEXITCODE -ne 0) { throw "Failed to build Workbridge Tauri Monitor." }
    } finally {
        Pop-Location
    }
}

$result = Invoke-CimMethod `
    -ClassName Win32_Process `
    -MethodName Create `
    -Arguments @{
        CommandLine = "`"$exe`""
        CurrentDirectory = $cwd
    }

if ($result.ReturnValue -ne 0) {
    throw "Failed to launch Workbridge Tauri Monitor. Win32_Process.Create returned $($result.ReturnValue)."
}

Write-Host "Workbridge Tauri Monitor started independently. PID: $($result.ProcessId)"
