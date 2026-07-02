# Requires -RunAsAdministrator for Register-ScheduledTask (optional if user has rights)
<#
.SYNOPSIS
  Install Windows Task Scheduler job: daily Juno autonomy + export + purge.

.USAGE
  .\scripts\install-daily-task.ps1
  .\scripts\install-daily-task.ps1 -Hour 7 -Minute 0
  .\scripts\install-daily-task.ps1 -Uninstall
#>
param(
  [int]$Hour = 7,
  [int]$Minute = 0,
  [switch]$Uninstall
)

$ErrorActionPreference = "Stop"
$RepoRoot = Split-Path -Parent $PSScriptRoot
$TaskName = "JunoDailyAutonomy"
$Wrapper = Join-Path $RepoRoot "scripts\run-daily-juno.ps1"

if ($Uninstall) {
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
  Write-Host "[daily-task] removed $TaskName"
  exit 0
}

if (-not (Test-Path $Wrapper)) {
  Write-Error "Missing wrapper: $Wrapper"
}

$Action = New-ScheduledTaskAction `
  -Execute "powershell.exe" `
  -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$Wrapper`"" `
  -WorkingDirectory $RepoRoot

$Trigger = New-ScheduledTaskTrigger -Daily -At ([datetime]::Today.AddHours($Hour).AddMinutes($Minute))

$Settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -StartWhenAvailable `
  -ExecutionTimeLimit (New-TimeSpan -Hours 12)

Register-ScheduledTask `
  -TaskName $TaskName `
  -Action $Action `
  -Trigger $Trigger `
  -Settings $Settings `
  -Description "Juno daily autonomy: fill iteration cap, export to isolated folder, purge runs/staging." `
  -Force | Out-Null

Write-Host "[daily-task] installed $TaskName at ${Hour}:$($Minute.ToString('00')) daily"
Write-Host "  wrapper: $Wrapper"
Write-Host "  manual:  pnpm daily:juno"
Write-Host "  config:  AgentWorkbench\config\daily-schedule.json"
