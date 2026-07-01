# Creates AgentWorkbench directory tree (default E:\AgentWorkbench).
param(
  [string]$Root = "E:\AgentWorkbench"
)

$dirs = @(
  "providers",
  "queue",
  "missions",
  "state",
  "runs",
  "staging/jinstone",
  "staging/sites",
  "daily",
  "prompts"
)

foreach ($d in $dirs) {
  New-Item -ItemType Directory -Force -Path (Join-Path $Root $d) | Out-Null
}

$config = @"
# AgentWorkbench global config — see wiki/overseer-plan.md §4
vault_path: "E:/Obsidian Vault"
default_provider: cursor_composer
quiet_hours:
  start: "23:00"
  end: "07:00"
promote:
  require_human: true
"@

$nowYaml = @"
updated: 2026-06-01T09:00:00+08:00
now:
  - id: jupiter-bench-001
    horizon: day
    kind: jinstone
    prompt: executor_jinstone
    provider: cursor_composer
    max_minutes: 25
  - id: site-phase-2-004
    horizon: mission
    kind: site
    mission_id: landing-site-2026
    phase_id: pages
    prompt: executor_generic
    provider: cursor_composer
    max_minutes: 25
backlog: []
"@

$orchestrator = @"
{
  "activeRunId": null,
  "activeRunStatus": "idle",
  "lastRunId": null,
  "updatedAt": "2026-06-01T09:00:00+08:00"
}
"@

$daily = @"
# Daily Digest — 2026-06-01

## 今日焦点
- Juno Overseer P2：Workbench 骨架 + now.yaml 解析
- Jupiter bench 冒烟（待接 SDK）

## 队列快照
见 `queue/now.yaml`（≤3 条 now + backlog）

## Promote 候选
（无 — staging 为空）
"@

$promptStub = "# Prompt stub — replace with full template from overseer-plan.md`n"

$utf8NoBom = New-Object System.Text.UTF8Encoding $false
function Write-Utf8NoBom([string]$Path, [string]$Content) {
  [System.IO.File]::WriteAllText($Path, $Content, $utf8NoBom)
}

$utf8NoBom = New-Object System.Text.UTF8Encoding $false
function Write-Utf8NoBom([string]$Path, [string]$Content) {
  [System.IO.File]::WriteAllText($Path, $Content, $utf8NoBom)
}

Set-Content -Path (Join-Path $Root "config.yaml") -Value $config -Encoding UTF8
Set-Content -Path (Join-Path $Root "queue/now.yaml") -Value $nowYaml -Encoding UTF8
Set-Content -Path (Join-Path $Root "state/orchestrator.json") -Value $orchestrator -Encoding UTF8
Set-Content -Path (Join-Path $Root "daily/2026-06-01.md") -Value $daily -Encoding UTF8

foreach ($name in @("morning_plan", "mission_plan", "executor_generic", "executor_jinstone", "evening_rollup")) {
  $p = Join-Path $Root "prompts/$name.md"
  if (-not (Test-Path $p)) {
    Set-Content -Path $p -Value ($promptStub + "name: $name") -Encoding UTF8
  }
}

# Copy Cursor Vault firewall hooks into Workbench (SDK local agent cwd).
$projectRoot = Split-Path -Parent $PSScriptRoot
$hooksSrc = Join-Path $projectRoot ".cursor"
$hooksDst = Join-Path $Root ".cursor"
if (Test-Path $hooksSrc) {
  New-Item -ItemType Directory -Force -Path $hooksDst | Out-Null
  Copy-Item -Path (Join-Path $hooksSrc "hooks.json") -Destination $hooksDst -Force
  Copy-Item -Path (Join-Path $hooksSrc "hooks") -Destination $hooksDst -Recurse -Force
}

$demoRunDir = Join-Path $Root "runs/demo-jupiter-bench"
New-Item -ItemType Directory -Force -Path (Join-Path $demoRunDir "output") | Out-Null

$demoManifest = @"
{
  "runId": "demo-jupiter-bench",
  "horizon": "day",
  "provider": "cursor_composer",
  "providerRef": "cursor_accounts.main",
  "model": "composer-2.5",
  "promptTemplate": "executor_jinstone",
  "cwd": "staging/jinstone",
  "maxMinutes": 25,
  "maxRetries": 3,
  "outputDir": "output",
  "successCriteria": "更新 checkpoint.md 并写入 staging/jinstone 一条冒烟记录"
}
"@

$demoCheckpoint = @"
# Checkpoint — demo-jupiter-bench

## 目标
Juno Overseer P2 冒烟：确认 SDK spawn + heartbeat + events.jsonl 链路。

## 进度
- [ ] 写入 staging/jinstone/smoke.txt
"@

Set-Content -Path (Join-Path $demoRunDir "manifest.json") -Value $demoManifest -Encoding UTF8
Set-Content -Path (Join-Path $demoRunDir "checkpoint.md") -Value $demoCheckpoint -Encoding UTF8

# Copy Cursor Vault firewall hooks into Workbench (SDK local agent cwd).
$projectRoot = Split-Path -Parent $PSScriptRoot
$hooksSrc = Join-Path $projectRoot ".cursor"
$hooksDst = Join-Path $Root ".cursor"
if (Test-Path $hooksSrc) {
  New-Item -ItemType Directory -Force -Path $hooksDst | Out-Null
  Copy-Item -Path (Join-Path $hooksSrc "hooks.json") -Destination $hooksDst -Force
  Copy-Item -Path (Join-Path $hooksSrc "hooks") -Destination $hooksDst -Recurse -Force
}

$demoRunDir = Join-Path $Root "runs/demo-jupiter-bench"
New-Item -ItemType Directory -Force -Path (Join-Path $demoRunDir "output") | Out-Null

$demoManifest = @"
{
  "runId": "demo-jupiter-bench",
  "horizon": "day",
  "provider": "cursor_composer",
  "providerRef": "cursor_accounts.main",
  "model": "composer-2.5",
  "promptTemplate": "executor_jinstone",
  "cwd": "staging/jinstone",
  "maxMinutes": 25,
  "maxRetries": 3,
  "outputDir": "output",
  "successCriteria": "更新 checkpoint.md 并写入 staging/jinstone 一条冒烟记录"
}
"@

$demoCheckpoint = @"
# Checkpoint — demo-jupiter-bench

## 目标
Juno Overseer P2 冒烟：确认 SDK spawn + heartbeat + events.jsonl 链路。

## 进度
- [ ] 写入 staging/jinstone/smoke.txt
"@

Set-Content -Path (Join-Path $demoRunDir "manifest.json") -Value $demoManifest -Encoding UTF8
Set-Content -Path (Join-Path $demoRunDir "checkpoint.md") -Value $demoCheckpoint -Encoding UTF8

$missionDir = Join-Path $Root "missions/landing-site-2026"
New-Item -ItemType Directory -Force -Path $missionDir | Out-Null

$missionYaml = @"
id: landing-site-2026
title: 径石营销着陆页
horizon: mission
status: ACTIVE
provider: cursor_composer
workspace: staging/sites/landing
success_criteria: "pnpm build 通过；staging/sites/landing/out 存在"
phases:
  - id: scaffold
    goal: "Next.js + Tailwind 脚手架可 dev"
    status: done
  - id: pages
    goal: "首页 + 产品 + 关于；移动端可用"
    status: in_progress
  - id: deploy
    goal: "Vercel 预览链或静态 export"
    status: queued
"@

$missionProgress = @"
# Mission Progress — landing-site-2026

| Phase | Status |
|-------|--------|
| scaffold | done |
| pages | in_progress |
| deploy | queued |

## 下一 run 预期
继续 pages phase，更新 checkpoint。
"@

Set-Content -Path (Join-Path $missionDir "mission.yaml") -Value $missionYaml -Encoding UTF8
Set-Content -Path (Join-Path $missionDir "progress.md") -Value $missionProgress -Encoding UTF8

$scheduler = @"
{
  "enabled": false,
  "runsToday": 0,
  "missionInjectIntervalMin": 90,
  "updatedAt": "2026-06-01T09:00:00+08:00"
}
"@
Set-Content -Path (Join-Path $Root "state/scheduler.json") -Value $scheduler -Encoding UTF8

Write-Host "AgentWorkbench scaffolded at $Root"
