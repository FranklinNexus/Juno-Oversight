<#
.SYNOPSIS
  Register the integrity-checked Juno Node runtime at Windows user logon.

.DESCRIPTION
  The task starts only the packaged Node daemon. It does not launch the Tauri/WebView surface,
  does not restart a terminally blocked daemon, and does not run immediately unless -StartNow
  is provided.
#>
[CmdletBinding(SupportsShouldProcess = $true)]
param(
  [switch]$Uninstall,
  [switch]$StartNow,
  [string]$NodePath
)

$ErrorActionPreference = "Stop"
$RepoRoot = (Resolve-Path (Split-Path -Parent $PSScriptRoot)).Path
$TaskName = "JunoOversightRuntime"
$RuntimeRoot = Join-Path $RepoRoot "src-tauri\resources\juno-runtime"
$RuntimeEntry = Join-Path $RuntimeRoot "scripts\start-juno-login.mjs"

function New-TaskSchedulerService {
  $Service = New-Object -ComObject "Schedule.Service"
  $Service.Connect()
  return $Service
}

if ($Uninstall) {
  if ($StartNow) {
    throw "-StartNow cannot be combined with -Uninstall"
  }
  if ($PSCmdlet.ShouldProcess($TaskName, "Unregister Windows logon task")) {
    $Service = New-TaskSchedulerService
    $RootFolder = $Service.GetFolder("\")
    try {
      $null = $RootFolder.GetTask("\$TaskName")
      $RootFolder.DeleteTask($TaskName, 0)
    } catch {
      if ($_.Exception.HResult -ne -2147024894) {
        throw
      }
    }
  }
  Write-Host "[juno-login] removed $TaskName (a running daemon is left unchanged)"
  exit 0
}

if ([System.Environment]::OSVersion.Platform -ne [System.PlatformID]::Win32NT) {
  throw "Juno login startup is supported only on Windows"
}
if (-not (Test-Path -LiteralPath $RuntimeEntry -PathType Leaf)) {
  throw "Packaged runtime is missing. Run: corepack pnpm juno:login:prepare"
}

if ([string]::IsNullOrWhiteSpace($NodePath)) {
  $NodeCommand = Get-Command node.exe -CommandType Application -ErrorAction Stop | Select-Object -First 1
  $NodePath = $NodeCommand.Source
}
$NodePath = (Resolve-Path -LiteralPath $NodePath).Path
if (-not (Test-Path -LiteralPath $NodePath -PathType Leaf)) {
  throw "Node executable does not exist: $NodePath"
}
$StableNodePath = (& $NodePath -p "require('node:fs').realpathSync.native(process.execPath)").Trim()
if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($StableNodePath)) {
  throw "Node executable could not resolve its stable installation path"
}
$NodePath = (Resolve-Path -LiteralPath $StableNodePath).Path

& $NodePath $RuntimeEntry "--config-root=$RepoRoot" --validate-only
if ($LASTEXITCODE -ne 0) {
  throw "Packaged Juno runtime validation failed with exit code $LASTEXITCODE"
}

function Quote-TaskArgument([string]$Value) {
  if ($Value.Contains('"') -or $Value.Contains("`r") -or $Value.Contains("`n")) {
    throw "Scheduled Task arguments cannot contain quotes or line breaks"
  }
  return '"' + $Value + '"'
}

$TaskArguments = @(
  (Quote-TaskArgument $RuntimeEntry),
  (Quote-TaskArgument "--config-root=$RepoRoot")
) -join " "
$CurrentUser = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name

if ($PSCmdlet.ShouldProcess($TaskName, "Register Windows logon task")) {
  $Service = New-TaskSchedulerService
  $RootFolder = $Service.GetFolder("\")
  $Task = $Service.NewTask(0)
  $Task.RegistrationInfo.Description = `
    "Juno integrity-checked Node runtime at user logon (no Tauri/WebView)."
  $Task.Principal.UserId = $CurrentUser
  $Task.Principal.LogonType = 3
  $Task.Principal.RunLevel = 0
  $Task.Settings.Enabled = $true
  $Task.Settings.AllowDemandStart = $true
  $Task.Settings.DisallowStartIfOnBatteries = $false
  $Task.Settings.StopIfGoingOnBatteries = $false
  $Task.Settings.StartWhenAvailable = $true
  $Task.Settings.MultipleInstances = 2
  $Task.Settings.Priority = 7
  $Task.Settings.ExecutionTimeLimit = "PT0S"
  $Task.Settings.RestartCount = 0

  $Trigger = $Task.Triggers.Create(9)
  $Trigger.UserId = $CurrentUser
  $Trigger.Enabled = $true
  $Action = $Task.Actions.Create(0)
  $Action.Path = $NodePath
  $Action.Arguments = $TaskArguments
  $Action.WorkingDirectory = $RuntimeRoot

  $null = $RootFolder.RegisterTaskDefinition(
    $TaskName,
    $Task,
    6,
    $CurrentUser,
    $null,
    3,
    $null
  )
  if ($StartNow) {
    $null = $RootFolder.GetTask("\$TaskName").Run($null)
  }
}

if ($WhatIfPreference) {
  Write-Host "[juno-login] validation passed; task registration skipped (-WhatIf)"
} else {
  Write-Host "[juno-login] installed $TaskName for $CurrentUser"
}
Write-Host "  runtime: $RuntimeRoot"
Write-Host "  node:    $NodePath"
Write-Host "  starts now: $([bool]$StartNow)"
