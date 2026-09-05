param(
    [Parameter(Mandatory = $true)]
    [ValidateSet("connect", "ensure", "status", "stop")]
    [string]$Action,

    [string]$TunnelId,
    [string]$Alias = "workbridge-mcp"
)

$ErrorActionPreference = "Stop"

$profileDir = Join-Path $env:APPDATA "@workbridge\secure-tunnel\profiles"
$profilePath = Join-Path $profileDir "$Alias.yaml"

if ($Action -eq "ensure" -and -not $TunnelId -and -not (Test-Path -LiteralPath $profilePath)) {
    Write-Output '{"configured":false,"ready":false,"skipped":true}'
    exit 0
}

$client = if ($env:WORKBRIDGE_TUNNEL_CLIENT_PATH) {
    $env:WORKBRIDGE_TUNNEL_CLIENT_PATH
} else {
    Join-Path $HOME "Documents\Intelligence Works\tools\openai-tunnel-client\tunnel-client.exe"
}

if (-not (Test-Path -LiteralPath $client)) {
    throw "tunnel-client was not found at $client. Set WORKBRIDGE_TUNNEL_CLIENT_PATH to override it."
}

if ($Action -eq "status") {
    & $client runtimes status $Alias --json
    exit $LASTEXITCODE
}

if ($Action -eq "stop") {
    & $client runtimes stop $Alias --json
    exit $LASTEXITCODE
}

if ($Action -eq "ensure") {
    $statusOutput = & $client runtimes status $Alias --json 2>$null
    $statusExitCode = $LASTEXITCODE
    $status = $null
    if ($statusExitCode -eq 0 -and $statusOutput) {
        try {
            $status = (($statusOutput -join [Environment]::NewLine) | ConvertFrom-Json)
        } catch {
            $status = $null
        }
    }
    if ($status -and $status.ready -eq $true) {
        $statusOutput
        exit 0
    }
    if (-not $TunnelId -and $status -and $status.tunnel_id -match '^tunnel_[0-9a-f]{32}$') {
        $TunnelId = $status.tunnel_id
    }
    if (-not $TunnelId -and (Test-Path -LiteralPath $profilePath)) {
        $profileText = Get-Content -LiteralPath $profilePath -Raw
        $match = [regex]::Match($profileText, 'tunnel_[0-9a-f]{32}')
        if ($match.Success) {
            $TunnelId = $match.Value
        }
    }
}

if (-not $env:CONTROL_PLANE_API_KEY) {
    $secretFile = Join-Path $env:USERPROFILE ".config\sops\secrets\global.sops.json"
    $sopsCommand = Get-Command sops -ErrorAction SilentlyContinue
    $sopsPath = if ($sopsCommand) { $sopsCommand.Source } else { $null }
    if (-not $sopsPath -and $env:LOCALAPPDATA) {
        $candidate = Join-Path $env:LOCALAPPDATA "Microsoft\WinGet\Packages\SecretsOPerationS.SOPS_Microsoft.Winget.Source_8wekyb3d8bbwe\sops.exe"
        if (Test-Path -LiteralPath $candidate) {
            $sopsPath = $candidate
        }
    }
    if ($sopsPath -and (Test-Path -LiteralPath $secretFile)) {
        $secretMap = (& $sopsPath decrypt $secretFile | Out-String | ConvertFrom-Json)
        if ($LASTEXITCODE -eq 0) {
            $sopsApiKey = [string]$secretMap.PSObject.Properties['CONTROL_PLANE_API_KEY'].Value
            if ($sopsApiKey) {
                $env:CONTROL_PLANE_API_KEY = $sopsApiKey.Trim()
            }
        }
    }
}

if (-not $env:CONTROL_PLANE_API_KEY) {
    throw "CONTROL_PLANE_API_KEY is required to start Secure Tunnel. Configure it in the shared SOPS secrets file or provide a process-level override."
}

if (-not $TunnelId) {
    throw "TunnelId is required. Run tunnel:launch once with -TunnelId to configure the managed Secure Tunnel."
}

if ($TunnelId -notmatch '^tunnel_[0-9a-f]{32}$') {
    throw "Invalid tunnel ID. Expected tunnel_ followed by 32 lowercase hexadecimal characters."
}

$arguments = @(
    "runtimes", "connect",
    "--alias", $Alias,
    "--profile", $Alias,
    "--profile-dir", $profileDir,
    "--mcp-server-url", "http://127.0.0.1:7676/mcp",
    "--runtime-api-key", "env:CONTROL_PLANE_API_KEY",
    "--tunnel-client-bin", $client,
    "--json"
)

$arguments += @("--tunnel-id", $TunnelId)

& $client @arguments
if ($LASTEXITCODE -ne 0) {
    exit $LASTEXITCODE
}

$finalStatusOutput = & $client runtimes status $Alias --json
if ($LASTEXITCODE -ne 0) {
    exit $LASTEXITCODE
}

if ($Action -eq "ensure") {
    try {
        $finalStatus = (($finalStatusOutput -join [Environment]::NewLine) | ConvertFrom-Json)
    } catch {
        throw "Secure Tunnel runtime returned invalid status after reconnect."
    }
    if ($finalStatus.ready -ne $true) {
        throw "Secure Tunnel runtime did not become ready after reconnect."
    }
}

$finalStatusOutput
exit 0
