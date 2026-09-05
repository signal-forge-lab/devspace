$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$exe = Join-Path $root "desktop\monitor\release\Workbridge Monitor-win32-x64\Workbridge Monitor.exe"
$cwd = Split-Path -Parent $exe

if (-not (Test-Path -LiteralPath $exe)) {
    throw "Workbridge Monitor executable was not found. Run: npm run monitor:desktop:pack"
}

$result = Invoke-CimMethod `
    -ClassName Win32_Process `
    -MethodName Create `
    -Arguments @{
        CommandLine = "`"$exe`""
        CurrentDirectory = $cwd
    }

if ($result.ReturnValue -ne 0) {
    throw "Failed to launch Workbridge Monitor. Win32_Process.Create returned $($result.ReturnValue)."
}

Write-Host "Workbridge Monitor started independently. PID: $($result.ProcessId)"
