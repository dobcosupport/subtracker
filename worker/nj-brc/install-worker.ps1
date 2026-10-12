$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

Write-Host "== NJ BRC Worker install ==" -ForegroundColor Cyan
try {
    $nodeVersion = node -v
    Write-Host "Node.js: $nodeVersion" -ForegroundColor Green
} catch {
    Write-Error "Node.js 18+ is required and must be available on PATH."
    exit 1
}

npm ci
if ($LASTEXITCODE -ne 0) { Write-Error "npm ci failed."; exit $LASTEXITCODE }

npx playwright install chromium
if ($LASTEXITCODE -ne 0) { Write-Error "Playwright Chromium install failed."; exit $LASTEXITCODE }

New-Item -ItemType Directory -Force -Path ".\logs" | Out-Null
if (-not (Test-Path ".env")) {
    Write-Host "Copy .env.example to .env and configure NJ_BRC_WORKER_KEY before starting." -ForegroundColor Yellow
}
Write-Host "Install complete. Start with: .\start-worker.ps1" -ForegroundColor Green
