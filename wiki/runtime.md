# Runtime — 队列 · Spawn · 自主 · API

**合并自**：`orchestrator.md` · `workbench.md` · `juno-bounded-autonomy.md` · `api-gateway.md` · `juno-daily-schedule.md`

Juno **Runtime** = `orchestrator/src/` + `scripts/` + Workbench 磁盘状态。

当前可信源码位置：

`C:\Users\kfr34\Desktop\Entrepreneurship\Juno Oversight`

旧 `C:\Users\kfr34\Desktop\Juno Oversight` 仅作为漂移/删除态旧仓库看待，不再作为运行入口。

---

## Workbench 布局

```
AGENT_WORKBENCH_ROOT/
├── queue/now.yaml      # 当前 Mission 队列
├── runs/<id>/          # checkpoint · events.jsonl · manifest
├── missions/<id>/      # north-star · scope-lock · progress
├── state/              # autonomy · planner · evolution · api-quota
│   ├── safety-baselines/<mission-hash>.json  # v3 frozen scope baseline
│   └── mission-completions/<sha256(mission-id)>.json # immutable completion receipt
└── config/             # charter · api-limits · evolution-unit
```

不进 git。HUD 只读快照。

---

## Slot 流水线

1. `materializeQueueRun` → `runs/<id>/`
2. Implement slot 若有 `missionId`：在 `state/safety-baselines/` 原子记录 v3 baseline（冻结 scope-lock、Git diff、非 Git Workbench 文件树）
3. `spawn-run` → OpenAI Codex SDK；旧 `cursor_composer` manifest 在执行前 canonicalize
4. Verify slot：先执行 scope-lock diff safety preflight，再验证目标产物与可信 Juno eval profile 命令
5. `evaluateCompletedRun` → dequeue / hold / block / revise
6. `markMissionPhaseDone` → 更新 `progress.md`
7. 普通 Mission 仅在最终 verify PASS、safety PASS 且 now/backlog 无同 Mission 项后，由父进程原子签发 completion receipt

Workbench 内由 Agent 生成的 `package.json` 脚本不会直接在宿主机执行；在接入 OS 级 verifier sandbox 前，这类 code/ui verify 会 fail-closed。Literature profile 只运行 Juno 自身的可信验证命令与领域产物检查。

Codex 获得 `runs/<id>/output/` 与当前 Mission 产物目录的写权限；`manifest.json`、`run-state.json`、`events.jsonl` 与可信 run checkpoint 由父进程持有。Implement Agent 写 `output/checkpoint.md`，父进程在 containment、大小与 secret redaction 检查后才提升为可信 run checkpoint。`missions/<id>/checkpoint.md` 仅为只读展示文件；Agent 时段修改它会被 safety gate 无条件 BLOCK。

详见 [juno-architecture.md §4](./juno-architecture.md#4-执行平面slot-流水线)。

### Agent provider

| `provider` | 能力 | 约束 |
|------------|------|------|
| `openai_codex` | `@openai/codex-sdk` 的真实 coding agent | implement=`workspace-write`；review/debate/vote=`read-only`；approval=`never`；网络默认关闭 |
| `cursor_composer` | **仅旧 queue/manifest 输入兼容标识** | 强制迁移到 `openai_codex`；Composer model id 会被清除 |
| `api_token` | 旧 Chat Completions 文本流 | **禁止作为 slot executor**，因为没有文件/shell/patch 工具 |

Queue item 使用 `provider: openai_codex` 即可启用 Codex；`model` 可选，省略时由当前 Codex runtime 选择默认模型。自主 runtime 只复用本机 Codex 登录态，不把 API key 注入 Agent 子进程。实现依据：[OpenAI Codex SDK](https://developers.openai.com/codex/sdk/)。

---

## Bounded autonomy

| 参数 | 默认 |
|------|------|
| `maxSelfIterationsPerDay` | 12 |
| `maxAutoQueueMissions` | 2 / 日 |

**命令**

```bash
corepack pnpm autonomy:tick              # 预览 planner
corepack pnpm juno:daemon                # 后台循环（推荐）
corepack pnpm mission:loop               # 队列头 Live slot
```

**状态文件**：`bounded-autonomy.json` · `mission-planner.json` · `juno-daemon.json`

### Windows 登录自启（低内存）

```bash
corepack pnpm juno:login:prepare    # 构建并生成带 SHA-256 清单的 Node runtime
corepack pnpm juno:login:install    # 仅注册当前用户登录任务，不立即启动
corepack pnpm juno:login:uninstall  # 移除后续登录启动；不误杀当前 daemon
```

登录任务直接执行已校验的 Node runtime，不启动 Tauri/WebView。任务使用 `IgnoreNew` 防止重复
实例，不配置失败自动重启；因此 terminal `blocked` / exit 5 不会被计划任务反复拉起。只有显式
执行 `scripts/install-juno-login-task.ps1 -StartNow` 才会在安装后立即启动。

Planner 优先级摘要见 [juno-architecture.md §2](./juno-architecture.md#2-控制平面bounded-autonomy--mission-planner)。

**Daemon 行为（2026-07）**

- `mission:loop` 尊重 `JUNO_SKIP_ORCHESTRATOR_BUILD`（daemon tick 不再每轮全量 build）
- runtime 脚本由当前 Node 直接执行 Corepack 的 pnpm JS 入口，不经过 Windows `.cmd` / shell
- planner snapshot 写入显式 arbitration policy：队列头与未完成 registry mission 优先于 drive proposal
- 空队列 exit **4** → 不计入日 cap
- terminal BLOCK 跨进程重启保持终态；只有显式人工解除后才可重跑
- daily batch 默认最多 5 个无进展 tick、3 个连续失败；未填 cap 时写 `blocked` 并返回 exit **5**
- 同一 autonomy day 内，daily 的 `blocked` / `failed` 终态只能用 `corepack pnpm daily:juno -- --unblock-daily` 显式解除；中断重启会继承失败/无进展预算
- build、tick 与 live slot 全部使用可中止的异步子进程和完整进程树 deadline；live deadline 取 manifest `maxMinutes + 5min`，父级 deadline 保证不早于子级
- auto-discover 使用 registry 的 `loopScript`（如 von-neumann → `evolution:tick`）
- Mission complete 只认 `state/mission-completions/<sha256(mission-id)>.json` 的严格 receipt；receipt 绑定 terminal run、run checkpoint SHA-256、evidence version 与完成时间。旧 mission checkpoint 不会被兼容洗白；`progress.md` 仅记录 phase 进度
- governance/state 文件缺失时可使用代码默认值；文件存在但 JSON 或控制字段畸形时 fail-closed

### Specialized literature daemons

| 入口 | 直接驱动 | 状态 / PID |
|------|----------|------------|
| `corepack pnpm agi:daemon` | `run-agi-literature-loop.mjs --skip-autonomy` | `state/agi-daemon.json` · `state/agi-daemon.pid` |
| `corepack pnpm book:daemon` | `run-axiom-book-loop.mjs --skip-autonomy --skip-build` | `state/book-daemon.json` · `state/book-daemon.pid` |

- `--interval-ms`、`--max-slots`、`--max-consecutive-failures` 必须是有界正整数；连续失败预算默认 **3**。
- 只有真实 checkpoint gate dequeue 才返回 exit **0**。空队列、纯清理或仅 REVISE transition 返回 exit **4**，不记作成功进展；显式 BLOCK 返回 exit **5**。
- exit 5 / 明确 `terminal_blocked` 会立即停机；其他非零或无进展连续达到 3 次后写 `terminal_blocked` 并退出，不再无限睡眠重试。
- PID 文件使用原子单实例 lease，并由 owner 清理。`agi:daemon:stop` 只有在 PID 与新鲜 active state 同时匹配时才发送信号，避免陈旧 PID 复用误杀。
- terminal block 不会因普通重启恢复。修复 `blockedReason` 后，操作员必须显式执行 `corepack pnpm agi:daemon -- --unblock-daemon` 或 `corepack pnpm book:daemon -- --unblock-daemon`；禁止配置盲目自动拉起。
- Mission checkpoint 不能证明完成。AGI 只有在 40 个 batch 与 north-star 领域证据全部通过后签发 `agi-literature-v1` receipt；公理之书只有在规划产物、20 章质量门、非重复检查与至少 95,000 汉字合并稿全部通过后签发 `axiom-book-v1` receipt。伪造或过早的 `STATUS: COMPLETE` 会 terminal block，且不会解锁 planner 依赖。

**2026-07-11 验证**

- `corepack pnpm package-manager:check` PASS
- `corepack pnpm orchestrator:build` PASS
- `corepack pnpm test` PASS（数量以本次全量输出为准）
- `corepack pnpm lint` PASS：0 errors / 0 warnings
- `npm audit --prefix orchestrator --workspaces=false` PASS：0 vulnerabilities
- `corepack pnpm build` PASS
- `corepack pnpm autonomy:tick --skip-build` dry-run：`juno-von-neumann-unit-2026` → `evolution:tick`

---

## API Gateway

`config/api-limits.json`：Codex RPM · lease 并发 · 日 token · backoff。SDK 的真实 usage 会校正预估 token；PID 死亡或 lease 到期可回收崩溃遗留 inflight。

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

## Legacy Scheduler

`scheduler-daemon.ts` 仅为旧 smoke/兼容入口。当前 HUD、Tauri 和 24/7 主驱动统一使用 `corepack pnpm juno:daemon`（`scripts/run-juno-daemon.mjs`）。Loop gate 见 [experiments.md §smoke](./experiments.md#smoke--meta)。
