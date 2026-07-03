# Juno Oversight — 维护手册

**最后更新**：2026-07-03（Self-optimize + API Gateway + quality-gate）

---

## 1. 环境要求

| 工具 | 版本建议 |
|------|----------|
| Node.js | **22.13+**（orchestrator / `pnpm tauri:dev` 门禁） |
| pnpm | 10+ |
| Rust | 1.77+（`tauri:dev` / 打包） |
| CURSOR_API_KEY | Orchestrator Live spawn（`.env.local`） |

---

## 2. 常用命令

```bash
pnpm install          # 安装依赖
pnpm dev              # predev 释放 3000 + next dev -p 3000
pnpm tauri:dev        # 桌面壳 + Next 热更新（需先能访问 localhost:3000）
pnpm clean            # 删除 out/ 与 .next/（排错时用；勿在 dev 跑着时 clean）
pnpm build            # clean + 静态导出到 out/（仅 production 启用 export）
pnpm preview          # 静态 out/ 本地预览（原 start）
pnpm lint             # ESLint
pnpm test             # Vitest 单元测试
pnpm orchestrator:build
pnpm verify:desktop   # test + lint + build + orchestrator + cargo check
pnpm ui:smoke         # HTTP 冒烟（需 dev server）
node scripts/simulate-smoke-loop.mjs   # 三 slot 门禁 dry 模拟
node scripts/sync-workbench-hooks.mjs   # 同步 hooks → AgentWorkbench
```

复制 `.env.example` 为 `.env.local`（`CURSOR_API_KEY`、`JUNO_OVERSIGHT_ROOT` 等）。

### 开发地址

| URL | 说明 |
|-----|------|
| http://localhost:3000 | 主 HUD（`pnpm dev`） |
| http://localhost:3000/dev/components | UI 组件目录（**仅 development**） |

`predev` 会尝试结束占用 **3000** 的旧进程（`scripts/free-port.mjs`）。若仍失败，手动 `taskkill` 后重试。不要用 `next start`（已改为 `pnpm preview`）。

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
    widgets/             # Overseer + 战术 Widget（见 wiki/modules/product.md）
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
orchestrator/src/        # scheduler、spawn-run、review-loop（见 wiki/modules/runtime.md）
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
| `api-gateway.test.ts` | 限速、配额、mission 容量 |
| `quality-gate.test.ts` | spaced-bold、章节 rubric |
| `bounded-autonomy.test.ts` | 自决策优先级 |
| `orchestrator-isolation.test.ts` | Workbench/Vault 隔离 |

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

详见 [orchestrator.md](./orchestrator.md)、[workbench.md](./workbench.md)。

```powershell
pnpm orchestrator:build
node scripts/simulate-smoke-loop.mjs
.\scripts\bootstrap-smoke-loop.ps1
node orchestrator/dist/spawn-run.js --manifest E:\AgentWorkbench\runs\<id>\manifest.json --dry-run
```

| 状态文件 | 关键字段 |
|----------|----------|
| `state/scheduler.json` | `enabled` — 人类控制 |
| `state/orchestrator.json` | `activeRunStatus` — `done` 触发出队 |

---

## 11. 变更记录

### 2026-07-03（Self-optimize + Quality Gate）

- `quality-gate.ts` — 程序化写书门禁（spaced-bold、公理、本书主张）
- `self-optimize.ts` — scan → rubric patch → workflow selection → MCP hints
- `book:quality-loop` / `self:optimize` / `pnpm api:quota`
- README 与 `config/README.md` 上线文档

### 2026-07-01（第七轮 — 120% Wiki）

- Wiki 新增：`orchestrator.md`、`workbench.md`、`widgets.md`
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
