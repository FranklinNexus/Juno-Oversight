# Wrapper for Task Scheduler / logon — loads env, runs daemon without visible console.
$ErrorActionPreference = "Stop"
$RepoRoot = Split-Path -Parent $PSScriptRoot

if (-not $env:AGENT_WORKBENCH_ROOT) {
  $env:AGENT_WORKBENCH_ROOT = "E:\AgentWorkbench"
}
if (-not $env:WISDOMECHOES_ROOT) {
  $env:WISDOMECHOES_ROOT = "C:\Users\kfr34\Desktop\Entrepreneurship\WisdomEchoes.net"
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
# Detached node — no pnpm/cmd.exe popup; logs to juno-daemon.log
& node (Join-Path $RepoRoot "scripts\start-juno-daemon-hidden.mjs")
exit $LASTEXITCODE
