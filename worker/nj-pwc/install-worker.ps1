# SubTracker NJ PWC Worker — install
# Verifies Node.js, installs dependencies (npm ci), installs Playwright
# Chromium, and creates the log directory. Run from worker\nj-pwc.

$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

Write-Host "== NJ PWC Worker install ==" -ForegroundColor Cyan

# 1. Verify Node.js
try {
    $nodeVersion = node -v
    Write-Host "Node.js: $nodeVersion" -ForegroundColor Green
} catch {
    Write-Error "Node.js is not installed or not on PATH. Install Node.js 18+ and re-run."
    exit 1
}

# 2. Install dependencies
Write-Host "Installing dependencies (npm ci)..." -ForegroundColor Cyan
npm ci
if ($LASTEXITCODE -ne 0) { Write-Error "npm ci failed."; exit $LASTEXITCODE }

# 3. Install the Playwright Chromium browser
Write-Host "Installing Playwright Chromium browser..." -ForegroundColor Cyan
npx playwright install chromium
if ($LASTEXITCODE -ne 0) { Write-Error "Playwright Chromium install failed."; exit $LASTEXITCODE }

# 4. Create the log directory
$logPath = $env:WORKER_LOG_PATH
if (-not $logPath) { $logPath = ".\logs\nj-pwc-worker.log" }
$logDir = Split-Path -Parent (Resolve-Path $logPath -ErrorAction SilentlyContinue)
if (-not $logDir) { $logDir = ".\logs" }
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
Write-Host "Log directory ready: $logDir" -ForegroundColor Green

# 5. Remind about .env
if (-not (Test-Path ".env")) {
    Write-Host "NOTE: .env not found. Copy .env.example to .env and fill in real values before starting." -ForegroundColor Yellow
}

Write-Host "Install complete. Start with: .\start-worker.ps1" -ForegroundColor Green
