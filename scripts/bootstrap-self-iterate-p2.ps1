param([string]$Workbench = "E:\AgentWorkbench")
. (Join-Path $PSScriptRoot "lib/queue-bootstrap.ps1")

$missionId = "juno-self-iterate-p2-2026"
$yaml = @"
updated: $(Get-Date -Format "yyyy-MM-ddTHH:mm:sszzz")
now:
  - id: juno-si20-implement-p2
    horizon: mission
    kind: implement
    run_kind: implement
    repo_target: juno-overseer
    mission_id: $missionId
    phase_id: si20-implement-p2
    prompt: executor_implement
    provider: openai_codex
    workflow_id: self-iterate-p2
    eval_profile: orchestrator
    max_minutes: 25
    success_criteria: "workflow-search + bounded-autonomy + debate slot + AGI scaffold"
  - id: juno-si21-debate-p2
    horizon: mission
    kind: debate
    run_kind: debate
    repo_target: juno-overseer
    mission_id: $missionId
    phase_id: si21-debate-p2
    prompt: executor_review
    provider: openai_codex
    workflow_id: self-iterate-p2
    depends_on: si20-implement-p2
    max_minutes: 12
    success_criteria: "REVIEW_VERDICT PASS debate — architecture risks"
  - id: juno-si22-review-p2
    horizon: mission
    kind: review
    run_kind: review
    repo_target: juno-overseer
    mission_id: $missionId
    phase_id: si22-review-p2
    prompt: executor_review
    provider: openai_codex
    workflow_id: self-iterate-p2
    depends_on: si21-debate-p2
    max_minutes: 12
    success_criteria: "REVIEW_VERDICT PASS P2"
  - id: juno-si23-verify-p2
    horizon: mission
    kind: verify
    run_kind: verify
    repo_target: juno-overseer
    mission_id: $missionId
    phase_id: si23-verify-p2
    prompt: executor_verify
    provider: openai_codex
    workflow_id: self-iterate-p2
    eval_profile: orchestrator
    depends_on: si22-review-p2
    max_minutes: 20
    success_criteria: "test+build+workflow-search+autonomy PASS"
backlog:
  []
"@
Submit-JunoQueueCandidate -Workbench $Workbench -Yaml $yaml -BackupPrefix "bak-pre-p2"
Write-Host "P2 mission queued (4 slots). Run: pnpm loop:self-iterate-p2-run"
