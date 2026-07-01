# Bootstrap P1 self-iterate mission
param(
  [string]$Workbench = "E:\AgentWorkbench"
)

$missionId = "juno-self-iterate-p1-2026"
$nowPath = Join-Path $Workbench "queue/now.yaml"
if (Test-Path $nowPath) {
  $bak = Join-Path $Workbench "queue/now.yaml.bak-pre-self-iterate-p1-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
  Copy-Item $nowPath $bak
  Write-Host "Backed up queue -> $bak"
}

$utf8 = New-Object System.Text.UTF8Encoding $false
$nowYaml = @"
updated: $(Get-Date -Format "yyyy-MM-ddTHH:mm:sszzz")
now:
  - id: juno-si10-implement-p1
    horizon: mission
    kind: implement
    run_kind: implement
    repo_target: juno-overseer
    mission_id: $missionId
    phase_id: si10-implement-p1
    prompt: executor_implement
    provider: cursor_composer
    workflow_id: self-iterate-p1
    eval_profile: orchestrator
    max_minutes: 25
    success_criteria: "safety-verify + phase-dag + promote-mission-wiki"
  - id: juno-si11-review-p1
    horizon: mission
    kind: review
    run_kind: review
    repo_target: juno-overseer
    mission_id: $missionId
    phase_id: si11-review-p1
    prompt: executor_review
    provider: cursor_composer
    workflow_id: self-iterate-p1
    depends_on: si10-implement-p1
    max_minutes: 15
    success_criteria: "REVIEW_VERDICT PASS P1"
  - id: juno-si12-verify-p1
    horizon: mission
    kind: verify
    run_kind: verify
    repo_target: juno-overseer
    mission_id: $missionId
    phase_id: si12-verify-p1
    prompt: executor_verify
    provider: cursor_composer
    workflow_id: self-iterate-p1
    eval_profile: orchestrator
    depends_on: si11-review-p1
    max_minutes: 20
    success_criteria: "test+build+deps+SAFETY_VERIFY PASS"
backlog:
  []
"@

[System.IO.File]::WriteAllText($nowPath, $nowYaml, $utf8)
Write-Host "Mission $missionId queued (3 slots with depends_on)."
Write-Host "Run: pnpm loop:self-iterate-p1-run"
