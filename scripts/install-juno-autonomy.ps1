# Install Windows scheduled tasks: daily batch + logon daemon (no manual pnpm juno:daemon).
param(
  [int]$DailyHour = 0,
  [int]$DailyMinute = 0,
  [switch]$Uninstall,
  [switch]$StartDaemonNow
)

$ErrorActionPreference = "Stop"
$RepoRoot = Split-Path -Parent $PSScriptRoot
$DailyWrapper = Join-Path $RepoRoot "scripts\run-daily-juno.ps1"
$DaemonWrapper = Join-Path $RepoRoot "scripts\run-juno-daemon.ps1"
$DailyTask = "JunoDailyAutonomy"
$DaemonTask = "JunoMissionDaemon"

if ($Uninstall) {
  Unregister-ScheduledTask -TaskName $DailyTask -Confirm:$false -ErrorAction SilentlyContinue
  Unregister-ScheduledTask -TaskName $DaemonTask -Confirm:$false -ErrorAction SilentlyContinue
  Write-Host "[juno-autonomy] removed $DailyTask and $DaemonTask"
  exit 0
}

foreach ($w in @($DailyWrapper, $DaemonWrapper)) {
  if (-not (Test-Path $w)) { throw "Missing wrapper: $w" }
}

try {
$DailyAction = New-ScheduledTaskAction `
  -Execute "powershell.exe" `
  -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$DailyWrapper`"" `
  -WorkingDirectory $RepoRoot

$DailyTrigger = New-ScheduledTaskTrigger -Daily -At ([datetime]::Today.AddHours($DailyHour).AddMinutes($DailyMinute))

$Settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -StartWhenAvailable `
  -ExecutionTimeLimit (New-TimeSpan -Hours 12)

Register-ScheduledTask `
  -TaskName $DailyTask `
  -Action $DailyAction `
  -Trigger $DailyTrigger `
  -Settings $Settings `
  -Description "Juno daily: iteration cap + export + purge (+ daily:inbox when enabled)." `
  -Force | Out-Null
Write-Host "[juno-autonomy] installed $DailyTask"
} catch {
  Write-Warning "[juno-autonomy] $DailyTask skipped (need Admin for Task Scheduler): $($_.Exception.Message)"
}

try {
$DaemonAction = New-ScheduledTaskAction `
  -Execute "powershell.exe" `
  -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$DaemonWrapper`"" `
  -WorkingDirectory $RepoRoot

$DaemonTrigger = New-ScheduledTaskTrigger -AtLogOn

Register-ScheduledTask `
  -TaskName $DaemonTask `
  -Action $DaemonAction `
  -Trigger $DaemonTrigger `
  -Settings $Settings `
  -Description "Juno mission daemon — auto mission-loop from queue head (120s tick)." `
  -Force | Out-Null
Write-Host "[juno-autonomy] installed $DaemonTask  AtLogOn (hidden)"
} catch {
  Write-Warning "[juno-autonomy] $DaemonTask skipped (need Admin): $($_.Exception.Message)"
}

Write-Host "[juno-autonomy] scheduled tasks (if Admin OK):"
Write-Host "  $DailyTask  daily ${DailyHour}:$($DailyMinute.ToString('00'))"
Write-Host "  $DaemonTask  AtLogOn"
Write-Host "  logs: AgentWorkbench\state\daily-juno.log | juno-daemon.log"

if ($StartDaemonNow) {
  if (-not $env:AGENT_WORKBENCH_ROOT) { $env:AGENT_WORKBENCH_ROOT = "E:\AgentWorkbench" }
  $pidPath = Join-Path $env:AGENT_WORKBENCH_ROOT "state\juno-daemon.pid"
  $running = $false
  if (Test-Path $pidPath) {
    $old = [int](Get-Content $pidPath -Raw).Trim()
    if ($old -gt 0) {
      try { Get-Process -Id $old -ErrorAction Stop | Out-Null; $running = $true } catch { }
    }
  }
  if ($running) {
    Write-Host "[juno-autonomy] daemon already running pid=$old"
  } else {
    Start-Process powershell.exe -ArgumentList "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$DaemonWrapper`"" -WorkingDirectory $RepoRoot
    Write-Host "[juno-autonomy] started daemon in background"
  }
}
