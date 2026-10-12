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
    foreach ($key in @("SUBTRACKER_BASE_URL", "NJ_BRC_WORKER_KEY")) {
        if ($envText -notmatch "(?m)^\s*$([regex]::Escape($key))\s*=\s*.+\S\s*$") {
            Write-Error "Missing required configuration: $key"
            exit 1
        }
    }
}

Write-Host "Starting the separate NJ BRC worker. Do not start a second instance." -ForegroundColor Cyan
node worker.js
