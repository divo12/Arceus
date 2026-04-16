$base = "http://127.0.0.1:4096"

# Get all sessions
$sessionsRaw = (Invoke-WebRequest -Uri "$base/session" -TimeoutSec 10).Content
$sessions = $sessionsRaw | ConvertFrom-Json
Write-Host "Total sessions: $($sessions.Count)"

# Check first 10 for messages
$checked = 0
foreach ($s in $sessions) {
    if ($checked -ge 10) { break }
    $checked++
    $msgRaw = (Invoke-WebRequest -Uri "$base/session/$($s.id)/message" -TimeoutSec 5).Content
    $msgs = $msgRaw | ConvertFrom-Json
    if ($msgs.Count -gt 0) {
        Write-Host "=== Session $($s.id) ($($msgs.Count) msgs) ==="
        foreach ($m in $msgs) {
            $partCount = if ($m.parts) { $m.parts.Count } else { 0 }
            $tin = if ($m.tokens -and $m.tokens.input) { $m.tokens.input } else { 0 }
            $tout = if ($m.tokens -and $m.tokens.output) { $m.tokens.output } else { 0 }
            $role = $m.role
            Write-Host "  role=$role parts=$partCount tin=$tin tout=$tout"
            if ($partCount -gt 0) {
                foreach ($p in $m.parts) {
                    if ($p.text) {
                        $snippet = $p.text.Substring(0, [Math]::Min(120, $p.text.Length))
                        Write-Host "    text: $snippet"
                    }
                    if ($p.type -eq "error") {
                        Write-Host "    ERROR part: $($p | ConvertTo-Json -Compress)"
                    }
                }
            }
        }
    }
}

# Now create a brand new session and test a prompt
Write-Host ""
Write-Host "=== Creating test session ==="
$sessionRaw = (Invoke-WebRequest -Uri "$base/session" -Method POST -ContentType "application/json" -Body '{}' -TimeoutSec 10).Content
$session = $sessionRaw | ConvertFrom-Json
$sid = $session.id
Write-Host "Session ID: $sid"

# Send a simple prompt (no agent param, using azure model)
Write-Host "Sending prompt..."
$body = @{
    content = "Reply with exactly: HELLO_FROM_AZURE"
    modelID = "gpt-4.1-mini"
} | ConvertTo-Json

try {
    $promptRaw = (Invoke-WebRequest -Uri "$base/session/$sid/message" -Method POST -ContentType "application/json" -Body $body -TimeoutSec 120).Content
    Write-Host "Prompt response: $($promptRaw.Substring(0, [Math]::Min(500, $promptRaw.Length)))"
} catch {
    Write-Host "Prompt failed: $($_.Exception.Message)"
    if ($_.Exception.Response) {
        Write-Host "Status: $($_.Exception.Response.StatusCode)"
        $reader = [System.IO.StreamReader]::new($_.Exception.Response.GetResponseStream())
        $errBody = $reader.ReadToEnd()
        $reader.Close()
        Write-Host "Error body: $errBody"
    }
}

# Also try with provider prefix
Write-Host ""
Write-Host "=== Trying with azure> prefix ==="
$body2 = @{
    content = "Reply with exactly: HELLO_FROM_AZURE"
    modelID = "azure>gpt-4.1-mini"
} | ConvertTo-Json
try {
    $promptRaw2 = (Invoke-WebRequest -Uri "$base/session/$sid/message" -Method POST -ContentType "application/json" -Body $body2 -TimeoutSec 120).Content
    Write-Host "Prompt response: $($promptRaw2.Substring(0, [Math]::Min(500, $promptRaw2.Length)))"
} catch {
    Write-Host "Prompt2 failed: $($_.Exception.Message)"
    if ($_.Exception.Response) {
        Write-Host "Status2: $($_.Exception.Response.StatusCode)"
        $reader2 = [System.IO.StreamReader]::new($_.Exception.Response.GetResponseStream())
        $errBody2 = $reader2.ReadToEnd()
        $reader2.Close()
        Write-Host "Error body2: $errBody2"
    }
}

# Check messages after prompt
Write-Host ""
Write-Host "=== Messages after prompt ==="
$msgRaw = (Invoke-WebRequest -Uri "$base/session/$sid/message" -TimeoutSec 5).Content
$msgs = $msgRaw | ConvertFrom-Json
Write-Host "Message count: $($msgs.Count)"
foreach ($m in $msgs) {
    $partCount = if ($m.parts) { $m.parts.Count } else { 0 }
    $tin = if ($m.tokens -and $m.tokens.input) { $m.tokens.input } else { 0 }
    $tout = if ($m.tokens -and $m.tokens.output) { $m.tokens.output } else { 0 }
    Write-Host "  role=$($m.role) parts=$partCount tin=$tin tout=$tout"
    if ($partCount -gt 0) {
        foreach ($p in $m.parts) {
            if ($p.text) {
                $snippet = $p.text.Substring(0, [Math]::Min(200, $p.text.Length))
                Write-Host "    text: $snippet"
            }
            if ($p.type -eq "error") {
                Write-Host "    ERROR: $($p | ConvertTo-Json -Compress)"
            }
        }
    }
}
