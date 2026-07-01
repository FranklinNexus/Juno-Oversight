# Bootstrap patch + literature missions, rebuild orchestrator, optionally start daemon.
param([switch]$StartDaemon)

$root = Split-Path -Parent $MyInvocation.MyCommand.Path | Split-Path -Parent
Set-Location $root

& "$root\scripts\bootstrap-next-missions.ps1"
& "$root\scripts\use-node22.ps1"

# Fix orchestrator deps locally before agent runs sl05
Push-Location "$root\orchestrator"
Remove-Item package-lock.json -Force -ErrorAction SilentlyContinue
npm uninstall juno-hud 2>$null
npm install
Pop-Location

pnpm orchestrator:build

if ($StartDaemon) {
  $env:AGENT_WORKBENCH_ROOT = "E:\AgentWorkbench"
  $env:JUNO_OVERSIGHT_ROOT = $root
  $env:JUNO_NODE_PATH = "C:\nvm4w\nodejs\node.exe"
  Get-Process -Name node -ErrorAction SilentlyContinue | Where-Object {
    $_.Path -like "*scheduler-daemon*" -or $_.CommandLine -like "*scheduler-daemon*"
  } | Stop-Process -Force -ErrorAction SilentlyContinue
  Start-Process -FilePath "C:\nvm4w\nodejs\node.exe" `
    -ArgumentList "orchestrator\dist\scheduler-daemon.js" `
    -WorkingDirectory $root -WindowStyle Hidden
  Start-Sleep -Seconds 2
  Write-Host "Scheduler daemon started."
}

Write-Host ""
Write-Host "=== Pipeline ===" -ForegroundColor Green
Write-Host "1. sl05 fix remaining bugs (~2min)"
Write-Host "2. sl06 reverify smoke loop (~2min)"
Write-Host "3. ar00-ar11: 100 papers -> wiki/juno-agent-architecture.md (~20-35min)"
Write-Host "Watch: E:\AgentWorkbench\queue\now.yaml"
