param(
    [string]$BatchId
)

$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Error "Node.js 18+ is required and must be available on PATH."
    exit 1
}
if (-not (Test-Path ".env")) {
    Write-Error ".env not found. Copy .env.example to .env and configure the BRC worker."
    exit 1
}
if (-not (Test-Path "node_modules\playwright")) {
    Write-Error "Worker dependencies are missing. Run .\install-worker.ps1 first."
    exit 1
}

$envText = Get-Content ".env" -Raw
$capture = $envText -match "(?m)^\s*NJ_BRC_CAPTURE_MODE\s*=\s*true\s*$"
if (-not $capture) {
    if ($BatchId -notmatch '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$') {
        Write-Error "Supply -BatchId with the Prepared Verification Batch ID. Global queue processing is not enabled."
        exit 1
    }
    foreach ($key in @("SUBTRACKER_BASE_URL", "NJ_BRC_WORKER_KEY")) {
        if ($envText -notmatch "(?m)^\s*$([regex]::Escape($key))\s*=\s*.+\S\s*$") {
            Write-Error "Missing required configuration: $key"
            exit 1
        }
    }
}

Write-Host "Starting the separate NJ BRC worker. Do not start a second instance." -ForegroundColor Cyan
if ($capture) {
    node worker.js
} else {
    node worker.js --batch $BatchId
}
exit $LASTEXITCODE
