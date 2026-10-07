# SubTracker NJ PWC Worker — start
# Verifies config is present and starts the worker with `node worker.js`.
# Run from worker\nj-pwc. Stop with Ctrl+C.

$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

Write-Host "== NJ PWC Worker start ==" -ForegroundColor Cyan

# Verify Node.js
try {
    $null = node -v
} catch {
    Write-Error "Node.js is not installed or not on PATH."
    exit 1
}

# Verify .env exists
if (-not (Test-Path ".env")) {
    Write-Error ".env not found. Copy .env.example to .env and fill in real values."
    exit 1
}

# Verify required config keys are present (values are never printed).
$envContent = Get-Content ".env" -Raw
foreach ($required in @("SUBTRACKER_BASE_URL", "COMPLIANCE_SYNC_RPA_KEY", "NJ_PWC_REPORT_URL")) {
    if ($envContent -notmatch [regex]::Escape($required) + "=") {
        Write-Error "Missing required config: $required"
        exit 1
    }
}

# Verify dependencies are installed
if (-not (Test-Path "node_modules\playwright")) {
    Write-Error "Dependencies not installed. Run .\install-worker.ps1 first."
    exit 1
}

$headless = "false"
if ($envContent -match "HEADLESS=(.+)") { $headless = $Matches[1].Trim() }
Write-Host "Starting worker (HEADLESS=$headless)..." -ForegroundColor Green

# 5. Start the worker
node worker.js
