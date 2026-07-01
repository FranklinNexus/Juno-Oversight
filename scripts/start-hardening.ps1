# One-shot: bootstrap hardening mission + build orchestrator.
param(
  [switch]$SkipBuild
)

$root = Split-Path -Parent $MyInvocation.MyCommand.Path | Split-Path -Parent
Set-Location $root

& "$root\scripts\bootstrap-juno-hardening.ps1"
& "$root\scripts\use-node22.ps1"

if (-not $SkipBuild) {
  pnpm orchestrator:build
}

Write-Host ""
Write-Host "=== Juno Hardening Mission Ready ===" -ForegroundColor Green
Write-Host "1. pnpm tauri:dev"
Write-Host "2. UI -> 24/7 Scheduler -> Start Daemon"
Write-Host "3. Watch Active Run / Mission Board (~5h, 12 slots)"
Write-Host ""
Write-Host "Pause: set scheduler.json enabled=false or Stop Daemon"
Write-Host "Resume: Start Daemon again"
