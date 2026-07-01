# Queue self-referential loop meta mission after smoke loop passes.
param(
  [string]$Workbench = "E:\AgentWorkbench",
  [string]$RepoRoot = "C:\Users\kfr34\Desktop\Entrepreneurship\Juno Oversight"
)

$missionId = "juno-loop-meta-2026"
$missionDir = Join-Path $Workbench "missions/$missionId"
New-Item -ItemType Directory -Force -Path $missionDir | Out-Null

$scopeLock = @"
# Scope Lock — $missionId

## 目标
用 **loop 自指** 优化 Overseer 架构：可重复本地 runner + queue-io + 文档。

## 允许修改（Juno）
- scripts/run-minimal-loop.mjs
- scripts/simulate-smoke-loop.mjs
- orchestrator/src/queue-io.ts
- orchestrator/src/scheduler-daemon.ts（仅改为 import queue-io）
- package.json（仅 \`loop:smoke\` / \`loop:meta\` scripts）
- wiki/architecture-loop.md、wiki/smoke-loop.md、wiki/orchestrator.md（loop 章节）

## 允许修改（Workbench）
- missions/$missionId/**

## 禁止
- orchestrator 新依赖、market/layout 大改、Vault 写入
"@

$northStar = @"
# North Star — Loop 自指优化

## 要证明
1. \`pnpm loop:smoke\` 一键跑通 smoke mission（implement→review→verify 本地）
2. \`queue-io.ts\` 被 scheduler 与 runner **共用**
3. 本 Mission 自身也走 implement→review→verify 过关

## 完成定义
meta02 verify 的 VERIFY_REPORT 全 PASS；wiki/architecture-loop.md 描述自指闭环。
"@

$progress = @"
# Mission Progress — $missionId

| Phase | Kind | Status |
|-------|------|--------|
| meta00-implement-runner | implement | queued |
| meta01-review-runner | review | queued |
| meta02-verify-runner | verify | queued |
"@

$utf8 = New-Object System.Text.UTF8Encoding $false
[System.IO.File]::WriteAllText((Join-Path $missionDir "scope-lock.md"), $scopeLock, $utf8)
[System.IO.File]::WriteAllText((Join-Path $missionDir "north-star.md"), $northStar, $utf8)
[System.IO.File]::WriteAllText((Join-Path $missionDir "progress.md"), $progress, $utf8)

# Preserve literature backlog from backup if present
$literatureBackup = Get-ChildItem (Join-Path $Workbench "queue/now.yaml.bak-pre-loop-*") -ErrorAction SilentlyContinue |
  Sort-Object LastWriteTime -Descending | Select-Object -First 1

$backlogYaml = "  []"
if ($literatureBackup) {
  $bakText = [System.IO.File]::ReadAllText($literatureBackup.FullName)
  if ($bakText -match "(?ms)now:\s*\r?\n((?:  - id:.*?)(?=\r?\nbacklog:))") {
    $items = $Matches[1].TrimEnd()
    $backlogYaml = $items
  }
}

$nowYaml = @"
updated: $(Get-Date -Format "yyyy-MM-ddTHH:mm:sszzz")
now:
  - id: juno-meta00-implement-runner
    horizon: mission
    kind: implement
    run_kind: implement
    repo_target: juno-overseer
    mission_id: $missionId
    phase_id: meta00-implement-runner
    prompt: executor_implement
    provider: cursor_composer
    max_minutes: 25
    success_criteria: "run-minimal-loop.mjs + queue-io + pnpm loop:smoke"
  - id: juno-meta01-review-runner
    horizon: mission
    kind: review
    run_kind: review
    repo_target: juno-overseer
    mission_id: $missionId
    phase_id: meta01-review-runner
    prompt: executor_review
    provider: cursor_composer
    max_minutes: 25
    success_criteria: "REVIEW_VERDICT PASS on loop runner"
  - id: juno-meta02-verify-runner
    horizon: mission
    kind: verify
    run_kind: verify
    repo_target: juno-overseer
    mission_id: $missionId
    phase_id: meta02-verify-runner
    prompt: executor_verify
    provider: cursor_composer
    max_minutes: 25
    success_criteria: "pnpm loop:smoke PASS; VERIFY_REPORT"
backlog:
$backlogYaml
"@

[System.IO.File]::WriteAllText((Join-Path $Workbench "queue/now.yaml"), $nowYaml, $utf8)

Write-Host "Mission $missionId queued (3 slots). Literature items in backlog if backup found."
Write-Host "Run: pnpm loop:meta  OR  node scripts/run-minimal-loop.mjs --skip-bootstrap (after editing queue)"
