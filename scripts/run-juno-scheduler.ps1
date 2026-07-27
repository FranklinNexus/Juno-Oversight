# Wrapper for Task Scheduler / logon: load project env and start one hidden scheduler.
$ErrorActionPreference = "Stop"
$RepoRoot = Split-Path -Parent $PSScriptRoot

if (-not $env:AGENT_WORKBENCH_ROOT) {
  $env:AGENT_WORKBENCH_ROOT = "E:\AgentWorkbench"
}
if (-not $env:JUNO_OVERSIGHT_ROOT) {
  $env:JUNO_OVERSIGHT_ROOT = $RepoRoot
}

$EnvLocal = Join-Path $RepoRoot ".env.local"
if (Test-Path $EnvLocal) {
  Get-Content $EnvLocal | ForEach-Object {
    if ($_ -match '^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$') {
      $name = $matches[1]
      $val = $matches[2].Trim().Trim('"').Trim("'")
      if (-not [string]::IsNullOrEmpty($name)) {
        Set-Item -Path "Env:$name" -Value $val
      }
    }
  }
}

Set-Location $RepoRoot
& node (Join-Path $RepoRoot "scripts\start-juno-scheduler-hidden.mjs")
exit $LASTEXITCODE
