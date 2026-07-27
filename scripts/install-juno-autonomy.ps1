# Install the single Juno scheduler at logon; optional legacy daily maintenance.
param(
  [int]$DailyHour = 0,
  [int]$DailyMinute = 0,
  [switch]$InstallDaily,
  [switch]$Uninstall,
  [switch]$StartDaemonNow
)

$ErrorActionPreference = "Stop"
$RepoRoot = Split-Path -Parent $PSScriptRoot
$DailyWrapper = Join-Path $RepoRoot "scripts\run-daily-juno.ps1"
$DaemonWrapper = Join-Path $RepoRoot "scripts\run-juno-scheduler.ps1"
$DailyTask = "JunoDailyAutonomy"
$DaemonTask = "JunoMissionDaemon"
$StartupDir = [Environment]::GetFolderPath("Startup")
$StartupShortcut = Join-Path $StartupDir "$DaemonTask.lnk"

if ($Uninstall) {
  Unregister-ScheduledTask -TaskName $DailyTask -Confirm:$false -ErrorAction SilentlyContinue
  Unregister-ScheduledTask -TaskName $DaemonTask -Confirm:$false -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $StartupShortcut -Force -ErrorAction SilentlyContinue
  Write-Host "[juno-autonomy] removed $DailyTask and all $DaemonTask startup entries"
  exit 0
}

foreach ($w in @($DaemonWrapper)) {
  if (-not (Test-Path $w)) { throw "Missing wrapper: $w" }
}

$Settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -StartWhenAvailable `
  -ExecutionTimeLimit (New-TimeSpan -Hours 12)

if ($InstallDaily) {
  if (-not (Test-Path $DailyWrapper)) { throw "Missing wrapper: $DailyWrapper" }
  try {
$DailyAction = New-ScheduledTaskAction `
  -Execute "powershell.exe" `
  -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$DailyWrapper`"" `
  -WorkingDirectory $RepoRoot

$DailyTrigger = New-ScheduledTaskTrigger -Daily -At ([datetime]::Today.AddHours($DailyHour).AddMinutes($DailyMinute))

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
} else {
  Unregister-ScheduledTask -TaskName $DailyTask -Confirm:$false -ErrorAction SilentlyContinue
  Write-Host "[juno-autonomy] removed legacy $DailyTask to prevent concurrent queue workers"
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
  -Description "Juno scheduler — single queue worker at user logon (5s tick)." `
  -Force | Out-Null
Remove-Item -LiteralPath $StartupShortcut -Force -ErrorAction SilentlyContinue
Write-Host "[juno-autonomy] installed $DaemonTask  AtLogOn (hidden)"
} catch {
  Write-Warning "[juno-autonomy] Task Scheduler unavailable, installing per-user Startup fallback: $($_.Exception.Message)"
  $PowerShell = Join-Path $PSHOME "powershell.exe"
  $Shell = New-Object -ComObject WScript.Shell
  $Shortcut = $Shell.CreateShortcut($StartupShortcut)
  $Shortcut.TargetPath = $PowerShell
  $Shortcut.Arguments = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$DaemonWrapper`""
  $Shortcut.WorkingDirectory = $RepoRoot
  $Shortcut.WindowStyle = 7
  $Shortcut.Description = "Juno single scheduler at user logon"
  $Shortcut.Save()
  if (-not (Test-Path $StartupShortcut)) { throw "Failed to install Startup shortcut: $StartupShortcut" }
  Write-Host "[juno-autonomy] installed per-user Startup shortcut: $StartupShortcut"
}

Write-Host "[juno-autonomy] scheduled tasks (if Admin OK):"
if ($InstallDaily) {
  Write-Host "  $DailyTask  daily ${DailyHour}:$($DailyMinute.ToString('00'))"
}
Write-Host "  $DaemonTask  AtLogOn (Task Scheduler or per-user Startup fallback)"
Write-Host "  log: AgentWorkbench\state\scheduler.log"

if ($StartDaemonNow) {
  if (-not $env:AGENT_WORKBENCH_ROOT) { $env:AGENT_WORKBENCH_ROOT = "E:\AgentWorkbench" }
  $pidPath = Join-Path $env:AGENT_WORKBENCH_ROOT "state\daemon.pid"
  $running = $false
  if (Test-Path $pidPath) {
    $raw = Get-Content $pidPath -Raw -ErrorAction SilentlyContinue
    if ($null -ne $raw -and $raw.Trim().Length -gt 0) {
      $old = [int]$raw.Trim()
      if ($old -gt 0) {
        try { Get-Process -Id $old -ErrorAction Stop | Out-Null; $running = $true } catch { }
      }
    }
  }
  if ($running) {
    Write-Host "[juno-autonomy] daemon already running pid=$old"
  } else {
    $node = (Get-Command node -ErrorAction Stop).Source
    Start-Process `
      -FilePath $node `
      -ArgumentList "`"$(Join-Path $RepoRoot 'scripts\start-juno-scheduler-hidden.mjs')`"" `
      -WorkingDirectory $RepoRoot `
      -WindowStyle Hidden
    Write-Host "[juno-autonomy] started scheduler detached (no window)"
  }
}
