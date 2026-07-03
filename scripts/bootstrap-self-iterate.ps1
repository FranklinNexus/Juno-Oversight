# Bootstrap self-iterate mission (P0) — queue 3 slots, backup current now.yaml
param(
  [string]$Workbench = "E:\AgentWorkbench",
  [string]$RepoRoot = "C:\Users\kfr34\Desktop\Entrepreneurship\Juno Oversight"
)

$missionId = "juno-self-iterate-2026"
$missionDir = Join-Path $Workbench "missions/$missionId"
New-Item -ItemType Directory -Force -Path $missionDir | Out-Null

$nowPath = Join-Path $Workbench "queue/now.yaml"
if (Test-Path $nowPath) {
  $bak = Join-Path $Workbench "queue/now.yaml.bak-pre-self-iterate-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
  Copy-Item $nowPath $bak
  Write-Host "Backed up queue -> $bak"
}

$utf8 = New-Object System.Text.UTF8Encoding $false

$nowYaml = @"
updated: $(Get-Date -Format "yyyy-MM-ddTHH:mm:sszzz")
now:
  - id: juno-si00-implement-p0
    horizon: mission
    kind: implement
    run_kind: implement
    repo_target: juno-overseer
    mission_id: $missionId
    phase_id: si00-implement-p0
    prompt: executor_implement
    provider: cursor_composer
    workflow_id: self-iterate
    eval_profile: orchestrator
    max_minutes: 25
    success_criteria: "workflows + events-schema + eval-profile + tests"
  - id: juno-si01-review-p0
    horizon: mission
    kind: review
    run_kind: review
    repo_target: juno-overseer
    mission_id: $missionId
    phase_id: si01-review-p0
    prompt: executor_review
    provider: cursor_composer
    workflow_id: self-iterate
    max_minutes: 15
    success_criteria: "REVIEW_VERDICT PASS P0 deliverables"
  - id: juno-si02-verify-p0
    horizon: mission
    kind: verify
    run_kind: verify
    repo_target: juno-overseer
    mission_id: $missionId
    phase_id: si02-verify-p0
    prompt: executor_verify
    provider: cursor_composer
    workflow_id: self-iterate
    eval_profile: orchestrator
    max_minutes: 20
    success_criteria: "pnpm test + orchestrator:build + deps PASS"
backlog:
  []
"@

[System.IO.File]::WriteAllText($nowPath, $nowYaml, $utf8)
Write-Host "Mission $missionId queued (3 slots)."
Write-Host "Run: pnpm loop:self-iterate-run  (local runner)"
Write-Host "Live: enable scheduler + spawn-run per slot (see wiki/architecture-loop.md §8)"
