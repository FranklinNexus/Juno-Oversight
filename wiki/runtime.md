# Runtime — 队列 · Spawn · 自主 · API

**合并自**：`orchestrator.md` · `workbench.md` · `juno-bounded-autonomy.md` · `api-gateway.md` · `juno-daily-schedule.md`

Juno **Runtime** = `orchestrator/src/` + `scripts/` + Workbench 磁盘状态。

---

## Workbench 布局

```
AGENT_WORKBENCH_ROOT/
├── queue/now.yaml      # 当前 Mission 队列
├── runs/<id>/          # checkpoint · events.jsonl · manifest
├── missions/<id>/      # north-star · scope-lock · progress
├── state/              # autonomy · planner · evolution · api-quota
└── config/             # charter · api-limits · evolution-unit
```

不进 git。HUD 只读快照。

---

## Slot 流水线

1. `materializeQueueRun` → `runs/<id>/`
2. `spawn-run` → Cursor Live 或本地 runner
3. `evaluateCompletedRun` → dequeue / hold / block / revise
4. `markMissionPhaseDone` → 更新 `progress.md`

详见 [juno-architecture.md §4](./juno-architecture.md#4-执行平面slot-流水线)。

---

## Bounded autonomy

| 参数 | 默认 |
|------|------|
| `maxSelfIterationsPerDay` | 12 |
| `maxAutoQueueMissions` | 2 / 日 |

**命令**

```bash
pnpm autonomy:tick              # 预览 planner
pnpm juno:daemon                # 后台循环（推荐）
pnpm mission:loop               # 队列头 Live slot
```

**状态文件**：`bounded-autonomy.json` · `mission-planner.json` · `juno-daemon.json`

Planner 优先级摘要见 [juno-architecture.md §2](./juno-architecture.md#2-控制平面bounded-autonomy--mission-planner)。

**Daemon 行为（2026-07）**

- `mission:loop` 尊重 `JUNO_SKIP_ORCHESTRATOR_BUILD`（daemon tick 不再每轮全量 build）
- 空队列 exit **4** → 不计入日 cap
- auto-discover 使用 registry 的 `loopScript`（如 von-neumann → `evolution:tick`）

---

## API Gateway

`config/api-limits.json`：RPM · 并发 · 日 token · backoff。

```bash
pnpm api:quota
```

---

## Daily export

```bash
pnpm daily:juno           # cap + 隔离导出
pnpm daily:juno:install   # Windows 0:00 计划任务
```

默认导出到 `JunoDailyExport/`（不进 Vault）。

---

## Scheduler（可选 24/7）

`scheduler-daemon.ts` — 5s tick，与 `juno:daemon` 二选一为主驱动。Loop gate 见 [experiments.md §smoke](./experiments.md#smoke--meta)。
