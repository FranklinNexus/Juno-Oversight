# Bootstrap short "smoke loop" mission (~75min, 3 slots) to validate implement→review→verify.
param(
  [string]$Workbench = "E:\AgentWorkbench",
  [string]$RepoRoot = ""
)

if ([string]::IsNullOrWhiteSpace($RepoRoot)) {
  $RepoRoot = Split-Path -Parent $PSScriptRoot
}

. (Join-Path $PSScriptRoot "lib/queue-bootstrap.ps1")

$missionId = "juno-smoke-loop-2026"
$missionDir = Join-Path $Workbench "missions/$missionId"
New-Item -ItemType Directory -Force -Path $missionDir | Out-Null

$scopeLock = @"
# Scope Lock — $missionId

## 目标
验证 Juno **最小 loop** 能在局部任务上过关（implement → review → verify）。

## 允许修改（Juno 仓库，仅此 Mission）
- scripts/ui-smoke.mjs（**新建**）
- scripts/verify-desktop.mjs（仅可追加调用 ui-smoke 一行，≤5 行）
- package.json（仅可新增 `"ui:smoke"` script）
- wiki/smoke-loop.md（**新建**，≤40 行说明）

## 允许修改（Workbench）
- missions/$missionId/**

## 禁止
- 改 orchestrator/package.json 依赖（尤其 **禁止** \`juno-hud: file:..\`）
- 改 src/components/market/**、layout/**、theme/**
- 新 Widget、新 Tauri command、大 refactor
- Obsidian Vault

## 完成定义
verify slot 的 VERIFY_REPORT 全 PASS 或 ui_smoke 对 localhost:3000 PASS。
"@

$northStar = @"
# North Star — Smoke Loop 试跑

## 要证明什么
1. **Implement** 能在 scope 内交付一个小脚本
2. **Review** 能写 REVIEW_VERDICT，不偷偷改功能
3. **Verify** 能跑 test + orchestrator 门禁 + UI 冒烟

## 交付物
- \`scripts/ui-smoke.mjs\`：请求 \`JUNO_DEV_URL\` 或 \`http://localhost:3000\`，要求 HTTP 200 且 body 不含 \`Internal Server Error\` / \`Turbopack error\` / \`Runtime Error\`
- \`pnpm ui:smoke\` 命令
- checkpoint 含 CHANGES +（review）REVIEW_VERDICT +（verify）VERIFY_REPORT

## 非目标
- Playwright 截图
- 修 market / build 全绿（build 失败可写在 verify notes，不扩大 scope）
"@

$progress = @"
# Mission Progress — $missionId

| Phase | Kind | Status |
|-------|------|--------|
| sl00-implement-ui-smoke | implement | queued |
| sl01-review-ui-smoke | review | queued |
| sl02-verify-smoke | verify | queued |

## 阻塞
（无）

## 下一 slot
sl00：实现 ui-smoke.mjs + package.json script。
"@

$utf8 = New-Object System.Text.UTF8Encoding $false
[System.IO.File]::WriteAllText((Join-Path $missionDir "scope-lock.md"), $scopeLock, $utf8)
[System.IO.File]::WriteAllText((Join-Path $missionDir "north-star.md"), $northStar, $utf8)
[System.IO.File]::WriteAllText((Join-Path $missionDir "progress.md"), $progress, $utf8)

$promptDir = Join-Path $Workbench "prompts"
New-Item -ItemType Directory -Force -Path $promptDir | Out-Null
$promptTemplates = [ordered]@{
  executor_implement = @"
# executor_implement — 实现 slot

读取 Mission 的 scope-lock.md 与 north-star.md，只修改允许路径。完成后运行相关测试，并在 checkpoint.md 写明状态与变更文件。
"@
  executor_review = @"
# executor_review — Review slot

独立检查 scope、代码 diff 与 checkpoint。禁止新增功能；在 checkpoint.md 写入 REVIEW_VERDICT（PASS、REVISE 或 BLOCK）。
"@
  executor_verify = @"
# executor_verify — 验证 slot

只运行 Mission 要求的验证并记录 VERIFY_REPORT。验证失败时如实报告，不在 verify slot 修复代码。
"@
}

foreach ($entry in $promptTemplates.GetEnumerator()) {
  $promptPath = Join-Path $promptDir ("{0}.md" -f $entry.Key)
  if (-not (Test-Path -LiteralPath $promptPath)) {
    [System.IO.File]::WriteAllText($promptPath, $entry.Value, $utf8)
  }
}

$hardeningBacklog = @"
  - id: juno-h06-review-loop-gate
    horizon: mission
    kind: review
    run_kind: review
    repo_target: juno-overseer
    mission_id: juno-overseer-hardening-2026
    phase_id: h06-review-loop-gate
    prompt: executor_review
    provider: openai_codex
    max_minutes: 25
    success_criteria: "REVIEW_VERDICT PASS on review loop"
"@

$nowYaml = @"
updated: $(Get-Date -Format "yyyy-MM-ddTHH:mm:sszzz")
now:
  - id: juno-sl00-implement-ui-smoke
    horizon: mission
    kind: implement
    run_kind: implement
    repo_target: juno-overseer
    mission_id: $missionId
    phase_id: sl00-implement-ui-smoke
    prompt: executor_implement
    provider: openai_codex
    max_minutes: 25
    success_criteria: "scripts/ui-smoke.mjs + pnpm ui:smoke；checkpoint 含 CHANGES"
  - id: juno-sl01-review-ui-smoke
    horizon: mission
    kind: review
    run_kind: review
    repo_target: juno-overseer
    mission_id: $missionId
    phase_id: sl01-review-ui-smoke
    prompt: executor_review
    provider: openai_codex
    max_minutes: 25
    success_criteria: "REVIEW_VERDICT PASS on ui-smoke"
  - id: juno-sl02-verify-smoke
    horizon: mission
    kind: verify
    run_kind: verify
    repo_target: juno-overseer
    mission_id: $missionId
    phase_id: sl02-verify-smoke
    prompt: executor_verify
    provider: openai_codex
    max_minutes: 25
    success_criteria: "VERIFY_REPORT: test PASS, check-orchestrator-deps PASS, ui:smoke PASS or documented SKIP"
backlog:
$hardeningBacklog
"@

Submit-JunoQueueCandidate -Workbench $Workbench -Yaml $nowYaml -BackupPrefix "bak-pre-smoke-loop"

$orch = @"
{
  "activeRunId": null,
  "activeRunStatus": "idle",
  "lastRunId": null,
  "updatedAt": "$(Get-Date -Format "o")"
}
"@
[System.IO.File]::WriteAllText((Join-Path $Workbench "state/orchestrator.json"), $orch, $utf8)

$sched = @"
{
  "enabled": false,
  "runsToday": 0,
  "missionInjectIntervalMin": 90,
  "lastAction": "bootstrap_smoke_loop",
  "updatedAt": "$(Get-Date -Format "o")",
  "daemonStartedAt": null,
  "lastTickAt": null
}
"@
[System.IO.File]::WriteAllText((Join-Path $Workbench "state/scheduler.json"), $sched, $utf8)

Write-Host "Mission $missionId ready: 3 slots (implement -> review -> verify)."
Write-Host "Hardening h06+ moved to backlog."
Write-Host "Ensure: pnpm dev --port 3000 running before sl02 verify."
Write-Host "Scheduler left disabled (enabled: false). Set enabled:true before starting daemon."
"Ensure: pnpm dev --port 3000 running before sl02 verify."
Write-Host "Scheduler left disabled (enabled: false). Set enabled:true before starting daemon."

"Ensure: pnpm dev --port 3000 running before sl02 verify."
Write-Host "Scheduler left disabled (enabled: false). Set enabled:true before starting daemon."
