param(
    [int]$ApiPort = 4000,
    [int]$UiPort = 3001,
    [switch]$SkipBuild,
    [switch]$SkipApi,
    [int]$StartupTimeoutSeconds = 45
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $repoRoot

$apiProcess = $null
$apiStdOutLog = Join-Path $repoRoot ".logs\api-dev.stdout.log"
$apiStdErrLog = Join-Path $repoRoot ".logs\api-dev.stderr.log"

function Ensure-LogDirectory {
    $logDir = Split-Path -Parent $apiStdOutLog
    if (-not (Test-Path $logDir)) {
        New-Item -ItemType Directory -Path $logDir | Out-Null
    }
}

function Reset-LogFile {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path
    )

    if (Test-Path $Path) {
        Remove-Item $Path -Force -ErrorAction SilentlyContinue
    }

    New-Item -ItemType File -Path $Path -Force | Out-Null
}

function Get-LogTail {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path,
        [int]$LineCount = 40
    )

    if (-not (Test-Path $Path)) {
        return ""
    }

    return (Get-Content $Path -Tail $LineCount -ErrorAction SilentlyContinue | Out-String)
}

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
        }
        catch {
        }

        Start-Sleep -Milliseconds 500
    }

    return $false
}

function Get-ListenerProcessIds {
    param(
        [Parameter(Mandatory = $true)]
        [int]$Port
    )

    $pids = @()

    try {
        $listeners = Get-NetTCPConnection -State Listen -ErrorAction Stop | Where-Object { $_.LocalPort -eq $Port }
        $pids = $listeners | ForEach-Object { $_.OwningProcess }
    }
    catch {
        try {
            $netstatLines = netstat -ano -p tcp | Select-String -Pattern (":{0}\s" -f $Port)
            foreach ($line in $netstatLines) {
                $parts = ($line.ToString() -split "\s+") | Where-Object { $_ }
                if ($parts.Length -ge 5 -and $parts[3] -eq "LISTENING") {
                    $pids += [int]$parts[4]
                }
            }
        }
        catch {
            Write-Warning "Could not inspect listeners on port $Port via Get-NetTCPConnection or netstat."
        }
    }

    return @($pids | Where-Object { $_ -and $_ -gt 0 } | Select-Object -Unique)
}

function Stop-PortListeners {
    param(
        [Parameter(Mandatory = $true)]
        [int[]]$Ports
    )

    foreach ($port in $Ports) {
        $listenerPids = Get-ListenerProcessIds -Port $port
        foreach ($listenerPid in $listenerPids) {
            try {
                Stop-Process -Id $listenerPid -Force -ErrorAction SilentlyContinue
                Write-Host "Stopped process $listenerPid on port $port"
            }
            catch {
            }
        }
    }
}

function Stop-ApiProcess {
    if ($null -ne $apiProcess -and -not $apiProcess.HasExited) {
        Stop-Process -Id $apiProcess.Id -Force -ErrorAction SilentlyContinue
    }
}

try {
    Write-Host "Cleaning occupied ports..."
    Stop-PortListeners -Ports @($ApiPort, $UiPort)

    if (-not $SkipBuild) {
        Write-Host "Rebuilding workspace..."
        npm run build

        Write-Host "Running typecheck..."
        npm run typecheck
    }

    if (-not $SkipApi) {
        Write-Host "Starting API on port $ApiPort..."
        Ensure-LogDirectory
        Reset-LogFile -Path $apiStdOutLog
        Reset-LogFile -Path $apiStdErrLog
        $apiCommand = "Set-Location '$repoRoot'; `$env:PORT='$ApiPort'; npm run dev:api"
        $apiProcess = Start-Process -FilePath "pwsh" -ArgumentList @("-NoProfile", "-Command", $apiCommand) -RedirectStandardOutput $apiStdOutLog -RedirectStandardError $apiStdErrLog -PassThru

        $apiReady = Wait-ForHttpReady -Url "http://127.0.0.1:$ApiPort/health" -TimeoutSeconds $StartupTimeoutSeconds
        if (-not $apiReady) {
            if ($apiProcess.HasExited) {
                $stderrTail = Get-LogTail -Path $apiStdErrLog
                $stdoutTail = Get-LogTail -Path $apiStdOutLog
                throw "API exited during startup. See $apiStdOutLog and $apiStdErrLog.`nSTDERR:`n$stderrTail`nSTDOUT:`n$stdoutTail"
            }

            throw "API did not become ready at http://127.0.0.1:$ApiPort/health within $StartupTimeoutSeconds seconds. See $apiStdOutLog and $apiStdErrLog for details."
        }

        Write-Host "API is ready."
        Write-Host "API stdout: $apiStdOutLog"
        Write-Host "API stderr: $apiStdErrLog"
    }

    Write-Host "Starting UI on port $UiPort..."
    $env:PORT = "$UiPort"
    npm run dev:web
}
finally {
    Remove-Item Env:PORT -ErrorAction SilentlyContinue
    Stop-ApiProcess
}