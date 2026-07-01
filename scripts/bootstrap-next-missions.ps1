# Bootstrap smoke-loop fix slots + agent-literature mission queue (via write-queue.mjs).
param(
  [string]$Workbench = "E:\AgentWorkbench",
  [switch]$PatchOnly,
  [switch]$LiteratureOnly
)

$root = Split-Path -Parent $MyInvocation.MyCommand.Path | Split-Path -Parent
$utf8 = New-Object System.Text.UTF8Encoding $false

$literatureMission = "juno-agent-literature-2026"
$litDir = Join-Path $Workbench "missions/$literatureMission"
New-Item -ItemType Directory -Force -Path (Join-Path $litDir "papers") | Out-Null

$scopeLock = @"
# Scope Lock — $literatureMission

## 目标
调研 **100 篇** auto-agent 前沿论文，沉淀架构文档 **反哺 Juno Overseer**。

## 允许（Workbench）
- missions/$literatureMission/**（papers/*.yaml, taxonomy.md, synthesis-notes.md, progress.md）

## 允许（Juno 仓库）
- wiki/juno-agent-architecture.md（**最终 synthesis**，≤500 行）
- wiki/agent-literature-index.md（索引表，链接 batch yaml）

## 禁止
- 改 orchestrator/package.json 依赖
- 改 src/** 代码（本 Mission 只产出文档）
- Obsidian Vault
- 单 slot 超过 30 篇（按 batch criteria）

## 完成定义
- papers 合计 ≥100 条有效条目
- wiki/juno-agent-architecture.md 含：分层架构图（文字/mermaid）、Juno 映射表、Review/Verify 模式对照
- 最终 verify PASS + STATUS: COMPLETE
"@

$northStar = @"
# North Star — Agent 文献 → Juno 架构

## 产出
1. **taxonomy.md** — 12–20 个主题维度（orchestration, memory, verification, multi-agent, …）
2. **papers/batch-01..04.yaml** — 各 25 篇，共 100
3. **wiki/juno-agent-architecture.md** — 从文献归纳的 **推荐架构**，逐条映射到 Juno 现有/缺口组件
4. **wiki/agent-literature-index.md** — 总表（编号、标题、主题、Juno hook）

## Juno 反哺重点
| 文献模式 | Juno 对应 |
|----------|-----------|
| Critic / verifier loop | executor_review + REVIEW_VERDICT |
| Hierarchical planner | scheduler + mission phases |
| Memory / checkpoint | checkpoint.md + events.jsonl |
| Tool sandbox | Workbench scope-lock + Vault hooks |
| Eval harness | verify:desktop + ui:smoke |

## 非目标
- 实现新代码
- 100 篇全文摘要（每篇 one_line 即可）
"@

$progress = @"
# Mission Progress — $literatureMission

| Phase | Kind | Papers | Status |
|-------|------|--------|--------|
| ar00-taxonomy | implement | 0 | queued |
| ar01-papers-01-25 | implement | 1-25 | queued |
| ar02-review-01-25 | review | 1-25 | queued |
| ar03-papers-26-50 | implement | 26-50 | queued |
| ar04-review-26-50 | review | 26-50 | queued |
| ar05-papers-51-75 | implement | 51-75 | queued |
| ar06-review-51-75 | review | 51-75 | queued |
| ar07-papers-76-100 | implement | 76-100 | queued |
| ar08-review-76-100 | review | 76-100 | queued |
| ar09-synthesis | implement | — | queued |
| ar10-review-synthesis | review | — | queued |
| ar11-verify | verify | all | queued |
"@

[System.IO.File]::WriteAllText((Join-Path $litDir "scope-lock.md"), $scopeLock, $utf8)
[System.IO.File]::WriteAllText((Join-Path $litDir "north-star.md"), $northStar, $utf8)
[System.IO.File]::WriteAllText((Join-Path $litDir "progress.md"), $progress, $utf8)

function New-QueueItem([hashtable]$s) {
  return @{
    id = $s.id
    horizon = "mission"
    kind = $s.kind
    run_kind = $s.kind
    repo_target = "juno-overseer"
    mission_id = $s.mission_id
    phase_id = $s.phase
    prompt = $s.prompt
    provider = "cursor_composer"
    max_minutes = $s.max
    success_criteria = $s.criteria
  }
}

$patchItems = @(
  (New-QueueItem @{
    id = "juno-sl05-fix-remaining"
    phase = "sl05-fix-remaining"
    kind = "implement"
    mission_id = "juno-smoke-loop-2026"
    prompt = "executor_implement"
    max = 15
    criteria = "修 idempotency/lint/build/lightweight-charts；永久移除 orchestrator juno-hud file:..；check-orchestrator-deps PASS"
  }),
  (New-QueueItem @{
    id = "juno-sl06-reverify-smoke"
    phase = "sl06-reverify-smoke"
    kind = "verify"
    mission_id = "juno-smoke-loop-2026"
    prompt = "executor_verify"
    max = 10
    criteria = "VERIFY_REPORT: test PASS, lint PASS, build PASS, check-orchestrator-deps PASS, ui:smoke PASS"
  })
)

$litSlots = @(
  @{ id = "juno-ar00-taxonomy"; phase = "ar00-taxonomy"; kind = "implement"; prompt = "executor_research"; max = 10; criteria = "taxonomy.md + papers/README.md 字段说明" },
  @{ id = "juno-ar01-papers-01-25"; phase = "ar01-papers-01-25"; kind = "implement"; prompt = "executor_research"; max = 15; criteria = "papers/batch-01.yaml 恰好 25 篇" },
  @{ id = "juno-ar02-review-01-25"; phase = "ar02-review-01-25"; kind = "review"; prompt = "executor_review"; max = 10; criteria = "REVIEW_VERDICT PASS batch-01 质量" },
  @{ id = "juno-ar03-papers-26-50"; phase = "ar03-papers-26-50"; kind = "implement"; prompt = "executor_research"; max = 15; criteria = "papers/batch-02.yaml 恰好 25 篇" },
  @{ id = "juno-ar04-review-26-50"; phase = "ar04-review-26-50"; kind = "review"; prompt = "executor_review"; max = 10; criteria = "REVIEW_VERDICT PASS batch-02" },
  @{ id = "juno-ar05-papers-51-75"; phase = "ar05-papers-51-75"; kind = "implement"; prompt = "executor_research"; max = 15; criteria = "papers/batch-03.yaml 恰好 25 篇" },
  @{ id = "juno-ar06-review-51-75"; phase = "ar06-review-51-75"; kind = "review"; prompt = "executor_review"; max = 10; criteria = "REVIEW_VERDICT PASS batch-03" },
  @{ id = "juno-ar07-papers-76-100"; phase = "ar07-papers-76-100"; kind = "implement"; prompt = "executor_research"; max = 15; criteria = "papers/batch-04.yaml 恰好 25 篇" },
  @{ id = "juno-ar08-review-76-100"; phase = "ar08-review-76-100"; kind = "review"; prompt = "executor_review"; max = 10; criteria = "REVIEW_VERDICT PASS batch-04；合计 100 篇" },
  @{ id = "juno-ar09-synthesis"; phase = "ar09-synthesis"; kind = "implement"; prompt = "executor_implement"; max = 15; criteria = "wiki/juno-agent-architecture.md + agent-literature-index.md" },
  @{ id = "juno-ar10-review-synthesis"; phase = "ar10-review-synthesis"; kind = "review"; prompt = "executor_review"; max = 10; criteria = "REVIEW_VERDICT PASS 架构反哺 Juno" },
  @{ id = "juno-ar11-verify"; phase = "ar11-verify"; kind = "verify"; prompt = "executor_verify"; max = 10; criteria = "papers>=100; wiki 存在; test+orchestrator-deps PASS; STATUS COMPLETE" }
)

$litItems = @()
foreach ($s in $litSlots) {
  $litItems += (New-QueueItem @{
    id = $s.id
    phase = $s.phase
    kind = $s.kind
    mission_id = $literatureMission
    prompt = $s.prompt
    max = $s.max
    criteria = $s.criteria
  })
}

$queuePayload = @{
  updated = (Get-Date -Format "yyyy-MM-ddTHH:mm:sszzz")
  now = @()
  backlog = @()
}

if ($PatchOnly) {
  $queuePayload.now = $patchItems
} elseif ($LiteratureOnly) {
  $queuePayload.now = $litItems
} else {
  $queuePayload.now = $patchItems + $litItems
}

$tmpJson = Join-Path $env:TEMP "juno-queue-$(Get-Date -Format 'yyyyMMddHHmmss').json"
[System.IO.File]::WriteAllText($tmpJson, ($queuePayload | ConvertTo-Json -Depth 6 -Compress), $utf8)
node "$root\scripts\write-queue.mjs" --json $tmpJson --out (Join-Path $Workbench "queue/now.yaml")
Remove-Item $tmpJson -ErrorAction SilentlyContinue

if (-not $PatchOnly -and -not $LiteratureOnly) {
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
  "enabled": true,
  "runsToday": 0,
  "missionInjectIntervalMin": 90,
  "lastAction": "bootstrap_sl05_and_literature",
  "updatedAt": "$(Get-Date -Format "o")"
}
"@
  [System.IO.File]::WriteAllText((Join-Path $Workbench "state/scheduler.json"), $sched, $utf8)
}

if ($PatchOnly) {
  Write-Host "Patch queue: sl05 + sl06."
} elseif ($LiteratureOnly) {
  Write-Host "Literature mission: 12 slots queued."
} else {
  Write-Host "Queue: sl05 -> sl06 -> ar00..ar11 (14 slots)."
  Write-Host "Keep pnpm dev --port 3000 for verify slots."
}
