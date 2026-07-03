# Juno Orchestrator — 编排引擎

**版本**：0.1  
**代码**：`orchestrator/src/`  
**Workbench 根**：`E:\AgentWorkbench`（`AGENT_WORKBENCH_ROOT`）

Orchestrator 把 **queue → slot → checkpoint → 出队** 自动化，供 24/7 Scheduler 与 Active Run 面板共用同一套 `spawn-run.js`。

---

## 1. 架构总览

```mermaid
flowchart LR
  subgraph wb [AgentWorkbench]
    Q[queue/now.yaml]
    R[runs/id/]
    S[state/]
    M[missions/]
  end
  subgraph orch [orchestrator/dist]
    SD[scheduler-daemon.js]
    SR[spawn-run.js]
  end
  subgraph ui [Juno HUD / Tauri]
    AR[Active Run Panel]
    DA[Daemon Panel]
  end
  Q --> SD
  SD -->|materializeQueueRun| R
  SD -->|spawn| SR
  SR -->|@cursor/sdk| Agent[Cursor Agent]
  SR --> R
  AR -->|spawn_agent_run| SR
  DA -->|start/stop| SD
  SR --> S
  SD --> S
  M --> SR
```

---

## 2. 模块职责

| 文件 | 职责 |
|------|------|
| `scheduler-daemon.ts` | 5s tick；读 `now.yaml`；spawn slot；watchdog（heartbeat 5min / maxMinutes+1）；`handleCompletedRun` 门禁 |
| `mission-planner.ts` | charter + registry → 下一 action；fitness v1 反馈 |
| `bounded-autonomy.ts` | 日限额、`recordAutonomyDecision`、evolution tick |
| `evolution-unit.ts` | fitness、evolution-log、planner 反馈、mutation allowlist |
| `hardening-queue.ts` | progress.md ↔ now.yaml 队列修复 |
| `model-defaults.ts` | Live 模型默认 + fallback 链 |
| `spawn-run.ts` | CLI `--manifest [--dry-run]`；model fallback；api-gateway |
| `manifest.ts` | QueueItem → RunManifest；`buildUserPrompt`（mission + quality + safety + checkpoint + events tail） |
| `review-loop.ts` | 解析 `REVIEW_VERDICT`；`resolveQueueAdvance` |
| `mission-progress.ts` | `evaluateCompletedRun`；`shouldMarkPhaseDone`；`markMissionPhaseDone` |
| `idempotency.ts` | `shouldSkipSpawn`；`mergeOrchestratorState` |
| `events.ts` | `events.jsonl` / `heartbeat.json` |
| `env.ts` | `JUNO_OVERSIGHT_ROOT`、`AGENT_WORKBENCH_ROOT`、`.env.local` |
| `safety-doctrine.ts` | 破坏性 shell 分类（与 hook 同步） |
| `api-token.ts` | OpenAI 兼容 HTTP fallback |
| `types.ts` | 共享类型 |
| `bounded-autonomy.ts` | 日限额、`recordAutonomyDecision`、evolution 挂钩 |
| `mission-planner.ts` | charter + registry → 下一 action；fitness v1 反馈 |
| `evolution-unit.ts` | fitness、evolution-log、mutation allowlist |
| `hardening-queue.ts` | progress.md ↔ now.yaml 修复（mission COMPLETE 时跳过） |
| `model-defaults.ts` | Live 模型默认 + fallback 链 |
| `api-gateway.ts` | RPM / 并发 / backoff |
| `workbench-purge.ts` | runs/staging 安全清理 |
| `autonomy-lock.ts` | daemon ↔ daily-juno 互斥 |
| `loop-gate.ts` | smoke/meta 24h stamp |
| `quality-gate.ts` | 书稿 scan、spaced-bold |
| `self-optimize.ts` | scan → rubric → workflow → MCP hints |

完整模块地图见 [juno-architecture.md §5](./juno-architecture.md#5-orchestrator-模块地图)。

---

## 3. Run 目录契约

每次 spawn 前 `materializeQueueRun(item)` 创建 `runs/<queueItem.id>/`：

| 文件 | 说明 |
|------|------|
| `manifest.json` | runId、runKind、provider、maxMinutes、missionId、phaseId、cwd |
| `queue-item.json` | 原始 queue 项快照 |
| `run-state.json` | slotIndex、retryCount、maxRetries |
| `checkpoint.md` | **跨 slot 唯一记忆**（CHANGES / REVIEW_VERDICT / VERIFY_REPORT） |
| `events.jsonl` | 审计事件流 |
| `heartbeat.json` | watchdog 刷新时间 |
| `output/` | agent 产出 |

---

## 4. Scheduler 状态机

### 4.1 tick 顺序

1. `enabled === false` → 跳过  
2. 有 `activeChild` → watchdog（heartbeat 过期或超时 → SIGTERM → `stall`）  
3. `orchestrator.json`：`running` → 等待  
4. `done` → `handleCompletedRun(runId)`  
5. `failed` / `stall` → 重试或 idle  
6. quiet hours → 跳过 spawn  
7. queue 空 → `queue_empty`  
8. `shouldSkipSpawn` → 跳过  
9. `materializeQueueRun` + spawn  

### 4.2 `handleCompletedRun` 出队规则

| `resolveQueueAdvance` | Scheduler 行为 |
|----------------------|----------------|
| `dequeue` | implement 需 `STATUS: COMPLETE`；否则 `await_complete` |
| `hold` | 保持队首（review 缺 verdict） |
| `block` | 保持队首，`lastAction: blocked` |
| `revise` | 出队 review 项，队首插入 fix implement slot |

出队成功后：`shouldMarkPhaseDone(runKind, checkpoint)` → 更新 `missions/<id>/progress.md` 对应 phase 为 `done`。

### 4.3 `shouldSkipSpawn`

| 原因 | 条件 |
|------|------|
| `active_running` | 同一 runId 正在 running |
| `last_run_dedup` | `lastRunId === next.id` 且 status 非 failed/stall |

重跑同一 id 前：将 `orchestrator.json` 的 `lastRunId` 置空或换 id。

---

## 5. Queue YAML 格式

```yaml
updated: 2026-07-01T12:00:00+08:00
now:
  - id: juno-sl00-implement-ui-smoke
    horizon: mission
    kind: implement
    run_kind: implement
    repo_target: juno-overseer
    mission_id: juno-smoke-loop-2026
    phase_id: sl00-implement-ui-smoke
    prompt: executor_implement
    provider: cursor_composer
    max_minutes: 25
    success_criteria: "…"
backlog:
  - id: …
```

**交替规则**（`validateReviewAlternation`）：implement → review → implement/verify；verify → review。

---

## 6. Provider

| provider | 用途 | 环境 |
|----------|------|------|
| `cursor_composer` | 默认；`@cursor/sdk` Agent | `CURSOR_API_KEY` |
| `api_token` | OpenAI 兼容 HTTP | `OPENAI_API_KEY` |

`spawn-run` 使用 `settingSources: ["project"]` 加载 Workbench `.cursor/hooks`。

---

# 一键跑通（本地，无 API）

```bash
pnpm loop:smoke      # smoke mission：bootstrap + 三 slot + 真实 verify
pnpm loop:meta       # 排队 meta 自指 mission（文献进 backlog）
pnpm loop:meta-run   # 跑 meta 三 slot
```

实现：`scripts/run-minimal-loop.mjs`（与 scheduler 共用 `queue-io`、`evaluateCompletedRun`）。

### Loop Gate

`orchestrator/src/loop-gate.ts` — Scheduler spawn 前可选检查。  
启用：`JUNO_REQUIRE_LOOP_GATE=1` 或 `config.yaml` → `scheduler.require_loop_gate: true`。

### 队列恢复

```bash
pnpm queue:restore-literature   # 文献 Mission backlog → now
```

`orchestrator/src/promote-queue.ts` — `promoteMissionFromBacklog` / `promoteBacklogToNow`。

---

## 7. 常用命令

```powershell
pnpm orchestrator:build
pnpm orchestrator:test:dry    # demo-jupiter-bench manifest

# 手动 daemon（需 Node 22+）
$env:AGENT_WORKBENCH_ROOT="E:\AgentWorkbench"
$env:JUNO_OVERSIGHT_ROOT="C:\Users\kfr34\Desktop\Entrepreneurship\Juno Oversight"
node orchestrator/dist/scheduler-daemon.js

# 单 slot dry-run
node orchestrator/dist/spawn-run.js --manifest E:\AgentWorkbench\runs\<id>\manifest.json --dry-run

# 门禁模拟（不 spawn）
node scripts/simulate-smoke-loop.mjs
```

Tauri 桌面：**WIDGET-S** 面板 Start/Stop Daemon，或 invoke `start_scheduler_daemon`。

---

## 8. 环境变量

| 变量 | 说明 |
|------|------|
| `AGENT_WORKBENCH_ROOT` | Workbench 根（默认 `E:\AgentWorkbench`） |
| `JUNO_OVERSIGHT_ROOT` | Juno 仓库根 |
| `CURSOR_API_KEY` | Composer spawn |
| `OPENAI_API_KEY` | api_token provider |
| `JUNO_NODE_PATH` | Scheduler 子进程 node 路径（可选） |

---

## 9. 与 Wiki 交叉引用

- Review 格式 → [overseer-quality.md §2–§9](./overseer-quality.md)
- Smoke loop Mission → [smoke-loop.md](./smoke-loop.md)
- Workbench 目录 → [workbench.md](./workbench.md)
- Tauri IPC → [widgets.md § Oversteer IPC](./widgets.md#6-tauri-ipc-完整表)
