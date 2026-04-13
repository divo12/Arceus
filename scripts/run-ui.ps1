param(
    [switch]$SkipApi,
    [int]$ApiPort = 4000,
    [int]$UiPort = 3000,
    [int]$StartupTimeoutSeconds = 30
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $repoRoot

$apiProcess = $null

function Wait-ForHttpReady {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Url,
        [int]$TimeoutSeconds = 30
    )

    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)

    while ((Get-Date) -lt $deadline) {
        try {
            $response = Invoke-WebRequest -UseBasicParsing -Uri $Url -TimeoutSec 3
            if ($response.StatusCode -ge 200 -and $response.StatusCode -lt 500) {
                return $true
            }
        } catch {
        }

        Start-Sleep -Milliseconds 500
    }

    return $false
}

function Stop-ApiProcess {
    if ($null -ne $apiProcess -and -not $apiProcess.HasExited) {
        Stop-Process -Id $apiProcess.Id -Force
    }
}

try {
    if (-not $SkipApi) {
        Write-Host "Starting API on port $ApiPort..."

        $apiCommand = "Set-Location '$repoRoot'; `$env:PORT='$ApiPort'; npm run dev:api"
        $apiProcess = Start-Process -FilePath "pwsh" -ArgumentList @("-NoProfile", "-Command", $apiCommand) -PassThru

        $apiReady = Wait-ForHttpReady -Url "http://localhost:$ApiPort/health" -TimeoutSeconds $StartupTimeoutSeconds
        if (-not $apiReady) {
            throw "API did not become ready at http://localhost:$ApiPort/health within $StartupTimeoutSeconds seconds."
        }

        Write-Host "API is ready."
    }

    Write-Host "Starting UI on port $UiPort..."
    $env:PORT = "$UiPort"
    npm run dev:web
}
finally {
    Remove-Item Env:PORT -ErrorAction SilentlyContinue
    Stop-ApiProcess
}