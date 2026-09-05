Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$monitorRoot = Split-Path -Parent $PSCommandPath
$appRoot = Join-Path $monitorRoot "release\Workbridge Monitor-win32-x64"
$exePath = Join-Path $appRoot "Workbridge Monitor.exe"

if (-not (Test-Path -LiteralPath $exePath -PathType Leaf)) {
  throw "Packaged Workbridge Monitor was not found at: $exePath"
}

$shell = New-Object -ComObject WScript.Shell

function Write-WorkbridgeShortcut([string]$shortcutPath) {
  $parent = Split-Path -Parent $shortcutPath
  [System.IO.Directory]::CreateDirectory($parent) | Out-Null

  $shortcut = $shell.CreateShortcut($shortcutPath)
  $shortcut.TargetPath = $exePath
  $shortcut.WorkingDirectory = $appRoot
  $shortcut.IconLocation = "$exePath,0"
  $shortcut.Description = "Workbridge Session Monitor"
  $shortcut.Save()
}

$desktopShortcut = Join-Path ([Environment]::GetFolderPath("Desktop")) "Workbridge Monitor.lnk"
$startMenuPrograms = Join-Path ([Environment]::GetFolderPath("StartMenu")) "Programs"
$startMenuShortcut = Join-Path $startMenuPrograms "Workbridge Monitor.lnk"

Write-WorkbridgeShortcut $desktopShortcut
Write-WorkbridgeShortcut $startMenuShortcut

Write-Host "Workbridge Monitor is ready."
Write-Host "Executable: $exePath"
Write-Host "Desktop shortcut: $desktopShortcut"
Write-Host "Start Menu shortcut: $startMenuShortcut"
