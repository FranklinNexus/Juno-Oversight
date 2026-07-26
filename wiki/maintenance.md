# Juno Oversight — 维护手册

**最后更新**：2026-07-15（workflow canary trust chain + legacy selection migration）

---

## 1. 环境要求

| 工具 | 版本建议 |
|------|----------|
| Node.js | **22.13+**（orchestrator / `pnpm tauri:dev` 门禁） |
| pnpm | **10.13.1**（由 Corepack + `packageManager` 固定） |
| Rust | 1.77+（`tauri:dev` / 打包） |
| Codex 登录 | 本机 Codex 已登录；Juno 不从 `.env.local` 注入 provider key |

---

## 2. 常用命令

```bash
corepack pnpm install --frozen-lockfile  # 一次安装 HUD + orchestrator workspace
pnpm dev              # next-dev 修 cache、释放 3000、启动 next dev
pnpm tauri:dev        # 桌面壳 + Next 热更新（需先能访问 localhost:3000）
pnpm clean            # 删除 out/ 与 .next/（排错时用；勿在 dev 跑着时 clean）
pnpm build            # clean + 静态导出到 out/（仅 production 启用 export）
pnpm preview          # 静态 out/ 本地预览（原 start）
pnpm lint             # ESLint
pnpm test             # Vitest 单元测试
pnpm orchestrator:build
pnpm evolution:canary                 # 只读列出 workflow experiments
pnpm workflow:selection:migrate       # 只读检查 legacy selection
pnpm verify:desktop   # test + lint + build + isolated dev smoke + orchestrator + cargo check/test
pnpm ui:smoke         # HTTP 冒烟（需 dev server）
node scripts/simulate-smoke-loop.mjs   # 三 slot 门禁 dry 模拟
node scripts/sync-workbench-hooks.mjs   # 仅供人工 Cursor 会话同步 hooks；不是 Codex sandbox/gate
```

`pnpm-lock.yaml` 是唯一依赖锁；不要在 `orchestrator/` 内运行 `npm install`。`orchestrator:build` 只检查依赖契约并编译，不会在自治运行期间联网安装。

`dev:smoke` 使用系统分配的空闲端口和 `localhost`，在临时隔离项目中编译；成功或失败都会确认 Next 进程树、端口和临时 `.next/dev` lock 已清理，不会复用或终止外部 dev server。

复制 `.env.example` 为 `.env.local`（`AGENT_WORKBENCH_ROOT`、`JUNO_OVERSIGHT_ROOT`）。

### 开发地址

| URL | 说明 |
|-----|------|
| http://localhost:3000 | 主 HUD（`pnpm dev`） |
| http://localhost:3000/dev/components | UI 组件目录（**仅 development**） |

`scripts/next-dev.mjs` 会修复脏 cache 并结束占用 **3000** 的旧 Next 进程。静态 export 用 `pnpm preview`；它通过内置只读 HTTP server 提供 `out/`。

### 桌面打包（Tauri）

1. `pnpm build` → 仅 **`next build`（NODE_ENV=production）** 时写入 `out/index.html`
2. `src-tauri/tauri.conf.json` → `frontendDist: "../out"`
3. `pnpm tauri build`

**开发**（`pnpm tauri:dev`）始终连 `devUrl: http://localhost:3000`，**不要**用带 `out/dev/` 的脏目录做 dev。

---

## 3. Next 配置要点（必读）

`next.config.ts` 行为：

| 命令 | `output: "export"` | 输出目录 |
|------|-------------------|----------|
| `pnpm dev` | **否** | `.next`（默认） |
| `pnpm build` | **是** | `out/` |

**切勿**在开发模式下长期开启 `output: "export"`。否则可能出现：

- 浏览器 / Tauri 窗口只显示 **`Internal Server Error`**
- `out/dev/` 与静态产物混在一起，Tauri 读错文件

**排错标准流程**：

```bash
# 1. 结束占用 3000 的旧 Next 进程（Windows 示例）
# 任务管理器结束 node，或: netstat -ano | findstr :3000 后 taskkill /PID <pid> /F

pnpm clean
pnpm dev
# 浏览器打开 http://localhost:3000 应看到 HUD，而非纯文本 Internal Server Error

# 桌面开发
pnpm tauri:dev

# 发布包
pnpm build
pnpm tauri build
```

---

## 4. 目录结构

```
src/
  app/
    api/market/          # dev only：quotes + klines（静态 build 不含）
    dev/components/      # UI 目录（development only）
  components/
    dashboard/           # HudViewport、LayoutCanvas、PanelWindow、顶栏
    widgets/             # Overseer + 战术 Widget（见 wiki/product.md）
    market/              # 行情 Hub、详情、图表
    ui/                  # HUD UI Kit
  hooks/
  lib/
    layout/              # widget-registry、presets、clamp、contentZoom
    workbench/           # orchestrator-client、测试
    market/live/         # Binance + Yahoo 聚合（LIVE 数据层）
    mock-feed-connection.ts
    jupiter-telemetry-hub.ts
  mocks/
  store/                 # layout-store v6、hud-store、market-store
orchestrator/src/        # scheduler、spawn-run、review-loop（见 wiki/runtime.md）
src-tauri/
scripts/
wiki/                    # 120% 文档索引见 wiki/README.md
out/                     # 仅 pnpm build；勿提交
```

### 4.1 布局相关模块

| 文件 | 职责 |
|------|------|
| `HudViewport.tsx` | FIT 计算；`transform: scale` + 宽高补偿 |
| `LayoutCanvas.tsx` | RGL v2 `GridLayout` + `createHudScaledStrategy` |
| `scaled-position-strategy.ts` | 缩放拖拽：scale 传给 DraggableCore，不用错误 calcDragPosition |
| `layout-store.ts` | 面板 CRUD、`spawnMarketSymbolPanel`（去重）、`stackOrder`、`contentZoom` persist **v6** |
| `symbol-popout-layout.ts` | 弹出窗右侧定位、cascade、同标的去重 |
| `lib/market/live/*` | Binance / Yahoo 拉取与聚合 |
| `hooks/useMarketFeed.ts` | LIVE/MOCK 分流 |
| `panel-preset.ts` | 1/4\|1/2\|FULL 按钮高亮匹配 |
| `panel-zoom.ts` | 窗内缩放 clamp / 步进 |
| `size-animation.ts` | 预设尺寸 CSS 过渡脉冲 |
| `grid-height.ts` | 网格像素高度工具（测试/调试用，运行时由 RGL `autoSize` 负责） |

---

## 5. 本地存储键

| Key | 版本 | 内容 |
|-----|------|------|
| `juno-layout-store` | **v6** | 面板几何、`widgetType`、`contentZoom`、`pinnedSymbol`、`stackOrder`；migrate 去重同标的 |
| `juno-market-store` | **v2** | 自选、`hubTab`、`selectedSymbol` |
| `juno-hud-prefs` | — | `theme`、`marketDataMode`（`mock` \| `live`） |

清除：DevTools → Application → Local Storage，或删对应 key；布局错乱可用顶栏 **RESET**。

---

## 6. Tauri IPC

完整表见 [widgets.md §6](./widgets.md#6-tauri-ipc-完整表)。

| Command | 用途 |
|---------|------|
| `get_hud_system_snapshot` | CPU/RAM |
| `get_jupiter_telemetry` | Infra Widget |
| `spawn_agent_run` / `kill_agent_run` | Active Run |
| `read_run_events` | events tail |
| `start_scheduler_daemon` / `stop_scheduler_daemon` / `get_scheduler_status` | WIDGET-S |
| `get_missions_snapshot` | Mission Board |
| `list_staging_entries` / `promote_to_vault` | Promote |

前端 Hub：

- `useRuntimeHudMetrics` — Tauri 可用时不跑 mock CPU 定时器；后台 tab 暂停轮询
- `jupiter-telemetry-hub` — 多 Infra 窗共享；监听全局 `mode` 切换轮询间隔

---

## 7. 行情数据（LIVE / MOCK）

### 7.1 顶栏切换

- **LIVE**（dev）：`useLiveMarketFeed` → `GET /api/market/quotes` → `lib/market/live/fetch-quotes.ts`
- **LIVE**（Tauri 静态包）：无 Route Handler → 切 **MOCK** 或 Phase 3 外置代理
- **MOCK**：`useMockWebSocket` + `generateMarketBatch`

| 市场 | LIVE 现价/K线 | 盘口 |
|------|----------------|------|
| Crypto | Binance REST | Binance depth（列表 ≤3 标的时） |
| US / HK / A股 | Yahoo Finance v7 / v8 | 合成五档（暂无 L2 API） |

K 线：`GET /api/market/klines?symbol=&timeframe=` → `fetchLiveOhlcSeries`（**仅 dev**）。

**限制**：`pnpm build` 静态导出**不含** `/api/*`；Tauri 发布包需 MOCK 或外置代理。

### 7.2 弹出窗

- `spawnMarketSymbolPanel(symbol)`：已有同 `pinnedSymbol` → **置顶**，不新建
- `dedupePinnedSymbolPanels`：加载/merge 时清理重复 ETH 等
- ⠿ / ↗：`usePopOutSymbol`；拖网格窗时 `body.hud-grid-interacting` 禁用 ⠿

### 7.3 Mock 连接态

每 Socket 实例：`feedId + useId()`。顶栏连接徽章 = 任一 feed 存活；LAT = max。LIVE 模式复用同一注册表上报延迟。

### 7.4 类型

统一 `src/lib/market/payload.ts` 的 `MarketPayload`（含 `source: mock|live`、`volume24h`）。Mock 生成器在 `mocks/generators/market-feed.ts`。

---

## 8. 测试

```bash
pnpm test
```

| 文件 | 覆盖 |
|------|------|
| `format.test.ts` | 格式化 |
| `clamp-panel.test.ts` | 网格 clamp（含 24 行上限） |
| `panel-zoom.test.ts` | 窗内缩放步进与边界 |
| `mock-feed-connection.test.ts` | 多实例连接 |
| `sanitize-watchlist.test.ts` | 自选清洗 |
| `symbol-popout-layout.test.ts` | 弹出定位、去重 |
| `indicators.test.ts` | EMA/MACD |
| `review-loop.test.ts` | REVIEW/VERIFY 出队逻辑 |
| `safety-doctrine.test.ts` | destructive shell 分类 |
| `spawn-idempotency.test.ts` | shouldSkipSpawn |
| `manifest-prompt.test.ts` | prompt 注入含 §11、MCP |
| `api-gateway.test.ts` | Codex 限速、lease 崩溃恢复、真实 token 校正 |
| `quality-gate.test.ts` | spaced-bold、章节 rubric |
| `bounded-autonomy.test.ts` | 自决策优先级 |
| `orchestrator-isolation.test.ts` | orchestrator 禁止父目录 symlink |
| `safety-verify.test.ts` | baseline v3、冻结 scope、Git/Workbench 越界与 secret |
| `verify-runner.test.ts` | 目标路由、shell-free 命令、secret redaction |
| `codex-executor.test.ts` | sandbox、事件证据、缺失 turn.completed fail-closed |

Orchestrator 逻辑在 `orchestrator/src/`；门禁单元测试主要在 `review-loop.test.ts`（经 re-export 测 `shouldMarkPhaseDone`）。

---

## 9. 排错

| 现象 | 可能原因 | 处理 |
|------|----------|------|
| **Internal Server Error**（白底一行字） | dev 时误开 `output: "export"`；或 3000 上跑着坏掉的旧 Next | `pnpm clean` → 杀旧 node → `pnpm dev` |
| Tauri 开发窗口报错但浏览器正常 | `devUrl` 端口不对（3000 vs 3001） | 只保留一个 `pnpm dev` |
| Tauri 白屏 | 未 build 或 `out/` 无 `index.html` | `pnpm build` 后检查 `out/index.html` |
| `out/dev/server` 或 `out/dev/cache` | 曾在 export 模式下跑过 `next dev` | `pnpm clean` 后重来 |
| 顶栏 DISCONNECTED | 所有 Mock 实例已卸载 | 确认至少一个行情/GitHub 窗 |
| 布局错乱 | localStorage 损坏 | Reset 或删 `juno-layout-store` |
| 拖窗只能左右、不能放到下面 | 旧 12 行 + 垂直压缩 | 24 行 + `compactType: null`；画布空白处 **滚轮** 下移 |
| **按下瞬间窗体下跳** | RGL `calcDragPosition` 用视口坐标 | 用 `createHudScaledStrategy` |
| **拖拽全程错位** | 全局缩放未校正 | `transform` + `createHudScaledStrategy(uiScale)` |
| LIVE 行情失败（dev） | 网络 / API 502 | 切 MOCK；查 `/api/market/quotes` 响应 |
| LIVE 行情失败（Tauri 包） | 静态 export 无 API | 预期行为；用 MOCK |
| Scheduler 不出队 | checkpoint 缺 COMPLETE / REVIEW PASS | 见 [overseer-quality §8](./overseer-quality.md#8-checkpoint-结构跨-slot-契约) |
| progress.md 不更新 | checkpoint 不满足三态 done 条件 | `shouldMarkPhaseDone`（implement/review/verify） |

---

## 10. Orchestrator 运维

详见 [runtime.md](./runtime.md)、[juno-architecture.md](./juno-architecture.md)。

```powershell
pnpm orchestrator:build
node scripts/simulate-smoke-loop.mjs
.\scripts\bootstrap-smoke-loop.ps1
node orchestrator/dist/spawn-run.js --manifest E:\AgentWorkbench\runs\<id>\manifest.json --dry-run
```

| 状态文件 | 关键字段 |
|----------|----------|
| `state/juno-daemon.json` | `status`、连续失败/无进展预算、lastAction |
| `state/juno-daemon.pid` | 当前主 daemon PID；Tauri 会核验进程身份 |
| `state/orchestrator.json` | transport 状态；只有 checkpoint gate + safety PASS 才允许出队 |

### 10.1 手工 workflow canary

Canary controller 默认会先 build orchestrator。不要在 flags 前加独立的 `--`，否则严格参数解析器会把它当成未知参数。

```powershell
# 只读：列出全部实验 / 检查单个实验
pnpm evolution:canary
pnpm evolution:canary --id=<experiment-id>

# 创建或复用 proposal，不 queue、不运行、不激活
pnpm evolution:canary --baseline=axiom-book --candidate=variants/axiom-book-lean-v2 --target-mission=juno-axiom-book-2026 --source-phase=workflow-canary --episodes=2

# 下面每次只允许一个显式 mutation flag
pnpm evolution:canary --id=<experiment-id> --queue
pnpm evolution:canary --id=<experiment-id> --evaluate
pnpm evolution:canary --id=<experiment-id> --promote
pnpm evolution:canary --id=<experiment-id> --rollback
```

操作顺序：

1. Proposal 输出中记录 `experimentId`、`proposalSha256`、两个 workflow SHA、`promptSha256ByTemplate` 与 `fixtureSha256`。同 ID 的冲突 proposal 不会覆盖。
2. `--queue` 创建隔离 fixture/running record，并通过 queue revision CAS 入队。`now` 为空时实验直接进入 `now`；否则进入 backlog。实验已在 backlog 且 `now` 后来变空时，再次显式 `--queue` 会将它提升到 `now`，不重排外部 backlog。
3. 用正常 runtime 消费 queue。不要直接改生成的 sample、queue item、manifest、fixture receipt 或 prompt。
4. `--evaluate` 可重复执行。证据不足时保持 `running`；terminal 时写不可覆盖 decision receipt。两条 arm 每个 episode 都必须 deterministic verify PASS，candidate 还必须无退化且至少严格改善一项。
5. 只有 `accepted` 才执行 `--promote`。它会重算 workflow/prompt/fixture、比对 live evidence，并在 selection lease 下 CAS 安装 active selection。
6. 需要撤销时执行同一 experiment 的 `--rollback`。它只处理当前由该 accepted receipt 激活的 selection，不会覆盖 foreign writer，也不会恢复已失信的 previous selection。

`--queue`、`--evaluate`、`--promote`、`--rollback` 一次只能有一个；不带 action flag 的已有 ID 是 inspect。Proposal definition 会落盘 proposal，不能把它误认为只读。源码模式不应常规使用 `--skip-build`；desktop runtime 的脚本已经固定到构建阶段校验过的 runtime。

#### Canary 证据审计

| 检查点 | 必查字段 / 文件 |
|--------|-----------------|
| Proposal | workflow definition SHA、prompt template→SHA map、fixture template SHA、previous selection、proposal SHA |
| Queue slot | `experiment_id`、`experiment_arm`、`experiment_episode`、`source_phase_id`、`experiment_fixture_sha256`、`experiment_prompt_sha256`，以及 workflow/profile/mission/phase/runKind |
| Fixture | 每个 arm/episode 的 create-once receipt；fixture version、sample mission、template SHA、rendered files SHA |
| Manifest | `experimentPromptSha256`、`experimentFixtureSha256` 与 compiled slot 完全一致；prompt 在 materialize 和实际构造 user prompt 时各核对一次 |
| Evidence | exact queue item/manifest、Codex 或 deterministic verify artifact v2、checkpoint/events/attempt/slot/retry SHA 绑定、REVISE lineage、metrics 与 `evidenceSha256` |
| Selection | accepted decision receipt SHA；mission、candidate workflow 与 experiment 三者一致 |

`juno-axiom-book-2026` 使用 literature micro fixture v2。每个 sample 只有 `essay.md` 可修改；`brief.md`、`rubric.md`、`north-star.md`、`progress.md`、`scope-lock.md` 必须保持精确字节。PASS 要求 450-900 English words、Thesis/Argument/Counterargument/Conclusion、`[S1] [S2] [S3]`，以及 auditable、falsifiable、oversight 论证。Verifier 读取隔离 sample，不读取生产书产物。

任何 workflow 文件、prompt bytes、compiled slot、fixture receipt、manifest 或 evidence 在 proposal 后漂移，都应当作为阻断处理，而不是手工修 JSON 后继续。完整机制见 [evolution.md](./evolution.md)。

#### Verify completion 崩溃恢复

Terminal verify 不再先出队再签 receipt。Runtime 会先在
`state/mission-completion-intents/` 写 create-once intent，然后在 queue lease 内提交 dequeue 和
正式 receipt。Intent 绑定 exact queue head/revision、run checkpoint、evidence policy；AGI/book
还绑定 mission checkpoint 与 domain evidence。提交失败只会在精确 post revision 上恢复原 head，
不会覆盖 foreign queue writer。

所有 generic、scheduler、minimal、AGI 和 book 入口都会在运行新 slot 前 reconcile pending intent：
可信 receipt 已存在时清理 intent；terminal head 尚在时完成原事务；head 已移除时提交 receipt，
若提交仍失败则把原 head prepend 回 live queue 并保留其他任务。不要手工删除 intent、重写 receipt，
也不要重复执行已通过的 terminal verify；`busy` 时稍后重试，`blocked` 时先调查 intent、queue 与
控制文件的 hardlink/metadata 漂移。

### 10.2 Legacy workflow selection 迁移

先 inspect，默认不写任何状态：

```powershell
pnpm workflow:selection:migrate
```

按输出处理：

| `status` | 操作 |
|----------|------|
| `missing` | 无旧 selection，不需要迁移 |
| `legacy_v0` | 仅此状态允许按 inspect 返回的精确 SHA commit |
| `trusted_v1` | 禁止迁移；使用对应 accepted canary 的 `--rollback` |
| `unsupported` | 禁止自动删除；人工调查 malformed、forged v1 或未知 schema |

只有确认 daemon、autonomy、launcher、orchestrator 与 workflow experiment 都静默后才 commit：

```powershell
pnpm workflow:selection:migrate --commit --expected-sha256=<64-hex-from-inspect> --reason="Archive obsolete legacy v0 selection"
```

Commit 会自行再次检查静默条件和 selection lease。它只接受精确四字段 legacy schema（`workflowId`、`score`、`reasons`、`updatedAt`）、inspect 的 exact SHA、非空且最长 500 字符的 reason，以及不超过 64 KiB 的 exclusive regular file。以下情况全部 fail closed：

- SHA/bytes/file metadata 在 inspect 后变化；
- source 或 archive 是 symlink/hardlink，或 archive/receipt 内容冲突；
- daemon PID、autonomy lock、run-launcher lease、active orchestrator run 或 running experiment 仍存在；
- selection 是 trusted/forged v1、malformed、未知 schema，或 selection lease 正忙；
- receipt 已存在后 source 又被重建，或 foreign writer 在 commit 中抢占。

成功后确认：

```text
state/workflow-selection.json                                      不存在
state/workflow-selection-archive/<selection-sha256>.json           原始字节归档
state/workflow-selection-archive/<selection-sha256>.receipt.json   create-once 审计凭证
```

记录命令输出中的 `receiptSha256`。重复使用同一 expected SHA 会返回 `already_archived`，不会覆盖 archive 或 receipt。迁移不触碰 `queue/now.yaml`；若发现 lock/recovery/temp/preimage 残留，停止后续 promote 并调查，不要手工删除证据。

---

## 11. 变更记录

### 2026-07-03（Self-optimize + Quality Gate）

- `quality-gate.ts` — 程序化写书门禁（spaced-bold、公理、本书主张）
- `self-optimize.ts` — scan → rubric patch → workflow selection → MCP hints
- `book:quality-loop` / `self:optimize` / `pnpm api:quota`
- README 与 `config/README.md` 上线文档

### 2026-07-01（第七轮 — 120% Wiki）

- Wiki 新增的 Orchestrator/Workbench 内容现已合并到 `runtime.md` 与 `juno-architecture.md`
- LIVE dev：恢复 `src/app/api/market/*` → `lib/market/live/*`
- `shouldMarkPhaseDone`；bootstrap smoke 默认 `enabled: false`
- `simulate-smoke-loop.mjs`

### 2026-07-01（第六轮 — Overseer + 安全）

- Scheduler 接 `evaluateCompletedRun`、`shouldSkipSpawn`
- Hooks：`destructive-ops-gate.mjs`；Overseer Quad 默认布局

### 2026-06-02（第五轮 — LIVE + 布局）

- LIVE/MOCK；`/api/market`（dev）；弹出窗去重；24 行网格；contentZoom v6

### 更早

- Phase 1–2：Mock 行情、Tauri 探针、UI Kit、wiki 初版

**待办**：Tauri LIVE 代理、GitHub API、Jupiter SSH、E2E

---

## 12. 贡献约定

- 样式走 `@/components/ui`
- 新 Widget 只改 `widget-registry.tsx`
- 持久化变更必须 `version` + `migrate`
- 布局/缩放逻辑放 `src/lib/layout/`，避免堆在组件内
- 产品 → `whitepaper.md`；运维 / 排错 → 本文件
