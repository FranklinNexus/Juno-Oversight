# Bootstrap long-running "Juno Overseer hardening" mission (~5h of 25min slots).
param(
  [string]$Workbench = "E:\AgentWorkbench",
  [string]$RepoRoot = "C:\Users\kfr34\Desktop\Entrepreneurship\Juno Oversight"
)

$missionId = "juno-overseer-hardening-2026"
$missionDir = Join-Path $Workbench "missions/$missionId"
New-Item -ItemType Directory -Force -Path $missionDir | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $Workbench "prompts") | Out-Null

$scopeLock = @"
# Scope Lock — $missionId

## 允许修改（Juno 仓库）
- wiki/overseer-quality.md, wiki/overseer-dev-kickoff.md
- orchestrator/**
- src-tauri/src/**
- src/components/widgets/**, src/hooks/**, src/lib/workbench/**
- scripts/**
- .cursor/skills/juno-quality-gate/**

## 允许修改（Workbench）
- missions/$missionId/**
- prompts/executor_implement.md, executor_review.md, executor_verify.md
- queue/now.yaml（仅 Scheduler 或本 bootstrap）

## 禁止
- 删除 market 模块以外的无关大重构
- Obsidian Vault 任何路径
- 新 Widget 类型超过 2 个/phase
- 改 package  major 版本
- 提交含 API Key / .env.local

## 本轮 North Star 锚点
见 north-star.md
"@

$northStar = @"
# North Star — Juno Overseer 工作流完善

## 什么叫「超出典型 Agent 项目」

1. **Review 门禁**：Implement / Review / Verify 三态交替；REVIEW_VERDICT 机器可读
2. **防漂移**：scope-lock + 每 slot 重读；major drift = BLOCK
3. **可复盘**：events.jsonl 流式 + checkpoint 结构化
4. **可验证**：verify slot 跑 test/lint/cargo；失败不 mark done
5. **长任务**：5h+ 无人值守仍保持 scope；slot 续跑不重复劳动
6. **幂等**：同 runId 不 double-spawn；orchestrator 状态一致

## 非目标（本轮不做）
- Jupiter 真 SSH（P3）
- Vault 自动 git commit
- 全新 UI  redesign
"@

$progress = @"
# Mission Progress — $missionId

| Phase | Kind | Status |
|-------|------|--------|
| h00-audit | review | queued |
| h01-quality-doc | implement | queued |
| h02-review-quality | review | queued |
| h03-idempotency | implement | queued |
| h04-review-idempotency | review | queued |
| h05-review-loop-code | implement | queued |
| h06-review-loop-gate | review | queued |
| h07-promote-preview | implement | queued |
| h08-review-promote | review | queued |
| h09-verify-all | verify | queued |
| h10-drift-audit | review | queued |
| h11-final | review | queued |

## 阻塞
（无）

## 下一 run 预期
h00-audit：只读 Review，输出 gap 分析与 REVIEW_VERDICT。
"@

$promptImplement = @"
# executor_implement — 实现 slot

你是 Juno Overseer **实现**短工。

## 必须
1. 开 slot 前读 scope-lock.md + north-star.md（Workbench missions 目录）
2. 只改 scope-lock 允许路径；**最小 diff**
3. 本 slot 结束更新 checkpoint.md（进度 + 变更文件列表）
4. 跑相关测试；失败写入 checkpoint，不要假装完成
5. 禁止扩大 Mission 范围

## 禁止
- 在 implement slot 做「最终 Review」—— 留给 executor_review
- 写 Obsidian Vault
"@

$promptReview = @"
# executor_review — Review slot（不写新功能）

你是 **独立 Reviewer**（非原 implementer 心态）。

## 必须
1. 读 scope-lock、north-star、checkpoint、events.jsonl 最近 40 行
2. 读 Juno 仓库 git diff（仅允许路径内）
3. 对照 wiki/overseer-quality.md 防漂移清单
4. 在 checkpoint.md 写入 **REVIEW_VERDICT**（PASS|REVISE|BLOCK）
5. verdict=PASS 才可在 checkpoint 勾 phase 完成

## 禁止
- 新功能、大重构、新依赖（除非 BLOCK 修复必需且 ≤20 行）
- 修改 Vault
"@

$promptVerify = @"
# executor_verify — 验证 slot

## 必须
1. 在 Juno 仓库根目录跑：`pnpm test`、`pnpm lint`、`cd src-tauri && cargo check`
2. 可选：`pnpm orchestrator:build`
3. 结果写入 checkpoint.md 的 ## VERIFY_REPORT
4. 任一失败 → REVIEW_VERDICT verdict=BLOCK

## 禁止
- 修代码（留给下一 implement）；只报告
"@

Set-Content -Path (Join-Path $missionDir "scope-lock.md") -Value $scopeLock -Encoding UTF8
Set-Content -Path (Join-Path $missionDir "north-star.md") -Value $northStar -Encoding UTF8
Set-Content -Path (Join-Path $missionDir "progress.md") -Value $progress -Encoding UTF8

Set-Content -Path (Join-Path $Workbench "prompts/executor_implement.md") -Value $promptImplement -Encoding UTF8
Set-Content -Path (Join-Path $Workbench "prompts/executor_review.md") -Value $promptReview -Encoding UTF8
Set-Content -Path (Join-Path $Workbench "prompts/executor_verify.md") -Value $promptVerify -Encoding UTF8

$nowYaml = @"
updated: $(Get-Date -Format "yyyy-MM-ddTHH:mm:sszzz")
now:
  - id: juno-h00-audit
    horizon: mission
    kind: review
    run_kind: review
    repo_target: juno-overseer
    mission_id: $missionId
    phase_id: h00-audit
    prompt: executor_review
    provider: cursor_composer
    max_minutes: 25
    success_criteria: "REVIEW_VERDICT + gap 分析；列出 6 条 must_fix 优先级"
  - id: juno-h01-quality-doc
    horizon: mission
    kind: implement
    run_kind: implement
    repo_target: juno-overseer
    mission_id: $missionId
    phase_id: h01-quality-doc
    prompt: executor_implement
    provider: cursor_composer
    max_minutes: 25
    success_criteria: "wiki/overseer-quality 与 prompts 一致；checkpoint 有变更列表"
  - id: juno-h02-review-quality
    horizon: mission
    kind: review
    run_kind: review
    repo_target: juno-overseer
    mission_id: $missionId
    phase_id: h02-review-quality
    prompt: executor_review
    provider: cursor_composer
    max_minutes: 25
    success_criteria: "REVIEW_VERDICT PASS on quality doc"
  - id: juno-h03-idempotency
    horizon: mission
    kind: implement
    run_kind: implement
    repo_target: juno-overseer
    mission_id: $missionId
    phase_id: h03-idempotency
    prompt: executor_implement
    provider: cursor_composer
    max_minutes: 25
    success_criteria: "spawn 幂等：同 activeRun 不重复；lastRunId 去重"
  - id: juno-h04-review-idempotency
    horizon: mission
    kind: review
    run_kind: review
    repo_target: juno-overseer
    mission_id: $missionId
    phase_id: h04-review-idempotency
    prompt: executor_review
    provider: cursor_composer
    max_minutes: 25
    success_criteria: "REVIEW_VERDICT PASS on idempotency"
  - id: juno-h05-review-loop-code
    horizon: mission
    kind: implement
    run_kind: implement
    repo_target: juno-overseer
    mission_id: $missionId
    phase_id: h05-review-loop-code
    prompt: executor_implement
    provider: cursor_composer
    max_minutes: 25
    success_criteria: "manifest 含 runKind/repoRoot；prompt 注入 scope-lock+events tail"
  - id: juno-h06-review-loop-gate
    horizon: mission
    kind: review
    run_kind: review
    repo_target: juno-overseer
    mission_id: $missionId
    phase_id: h06-review-loop-gate
    prompt: executor_review
    provider: cursor_composer
    max_minutes: 25
    success_criteria: "REVIEW_VERDICT PASS on review loop"
  - id: juno-h07-promote-preview
    horizon: mission
    kind: implement
    run_kind: implement
    repo_target: juno-overseer
    mission_id: $missionId
    phase_id: h07-promote-preview
    prompt: executor_implement
    provider: cursor_composer
    max_minutes: 25
    success_criteria: "Promote 干跑或 diff 摘要 Tauri command"
  - id: juno-h08-review-promote
    horizon: mission
    kind: review
    run_kind: review
    repo_target: juno-overseer
    mission_id: $missionId
    phase_id: h08-review-promote
    prompt: executor_review
    provider: cursor_composer
    max_minutes: 25
    success_criteria: "REVIEW_VERDICT PASS on promote safety"
  - id: juno-h09-verify-all
    horizon: mission
    kind: verify
    run_kind: verify
    repo_target: juno-overseer
    mission_id: $missionId
    phase_id: h09-verify-all
    prompt: executor_verify
    provider: cursor_composer
    max_minutes: 25
    success_criteria: "VERIFY_REPORT all green"
  - id: juno-h10-drift-audit
    horizon: mission
    kind: review
    run_kind: review
    repo_target: juno-overseer
    mission_id: $missionId
    phase_id: h10-drift-audit
    prompt: executor_review
    provider: cursor_composer
    max_minutes: 25
    success_criteria: "drift=none；scope_violations 为空"
  - id: juno-h11-final
    horizon: mission
    kind: review
    run_kind: review
    repo_target: juno-overseer
    mission_id: $missionId
    phase_id: h11-final
    prompt: executor_review
    provider: cursor_composer
    max_minutes: 25
    success_criteria: "STATUS: COMPLETE in checkpoint if all PASS"
backlog: []
"@

Set-Content -Path (Join-Path $Workbench "queue/now.yaml") -Value $nowYaml -Encoding utf8NoBOM

$scheduler = @"
{
  "enabled": true,
  "runsToday": 0,
  "missionInjectIntervalMin": 90,
  "lastAction": "bootstrap_hardening",
  "updatedAt": "$(Get-Date -Format "o")"
}
"@
Set-Content -Path (Join-Path $Workbench "state/scheduler.json") -Value $scheduler -Encoding UTF8

Write-Host "Mission $missionId bootstrapped."
Write-Host "Queue: 12 slots (~5h). Repo: $RepoRoot"
Write-Host "Next: pnpm orchestrator:build && pnpm tauri:dev -> Start Daemon"
