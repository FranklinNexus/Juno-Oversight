# Bootstrap P1 self-iterate mission
param(
  [string]$Workbench = "E:\AgentWorkbench"
)

. (Join-Path $PSScriptRoot "lib/queue-bootstrap.ps1")

$missionId = "juno-self-iterate-p1-2026"
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
    provider: openai_codex
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
    provider: openai_codex
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
    provider: openai_codex
    workflow_id: self-iterate-p1
    eval_profile: orchestrator
    depends_on: si11-review-p1
    max_minutes: 20
    success_criteria: "test+build+deps+SAFETY_VERIFY PASS"
backlog:
  []
"@

Submit-JunoQueueCandidate -Workbench $Workbench -Yaml $nowYaml -BackupPrefix "bak-pre-self-iterate-p1"
Write-Host "Mission $missionId queued (3 slots with depends_on)."
Write-Host "Run: pnpm loop:self-iterate-p1-run"
