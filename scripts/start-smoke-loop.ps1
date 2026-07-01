# One-shot: bootstrap 3-slot smoke loop mission + build orchestrator.
param([switch]$StartDaemon)

$root = Split-Path -Parent $MyInvocation.MyCommand.Path | Split-Path -Parent
Set-Location $root

& "$root\scripts\bootstrap-smoke-loop.ps1"
& "$root\scripts\use-node22.ps1"
pnpm orchestrator:build

if ($StartDaemon) {
  $env:AGENT_WORKBENCH_ROOT = "E:\AgentWorkbench"
  $env:JUNO_OVERSIGHT_ROOT = $root
  $env:JUNO_NODE_PATH = "C:\nvm4w\nodejs\node.exe"
  Start-Process -FilePath "C:\nvm4w\nodejs\node.exe" -ArgumentList "orchestrator\dist\scheduler-daemon.js" -WorkingDirectory $root -WindowStyle Hidden
  Start-Sleep -Seconds 2
  Write-Host "Scheduler daemon started in background."
}

Write-Host ""
Write-Host "=== Smoke Loop Mission ===" -ForegroundColor Green
Write-Host "1. Keep: pnpm dev --port 3000  (for sl02 ui:smoke)"
Write-Host "2. Watch: E:\AgentWorkbench\runs\juno-sl00-*\events.jsonl"
Write-Host "3. Optional UI: pnpm tauri:dev"
