# Widget 参考 — HUD 模块全集

**注册表**：`src/lib/layout/widget-registry.tsx`  
**新增 Widget**：只改 registry + 组件文件；持久化需 `layout-store` migrate。

Juno HUD 共 **10 种** Widget：6 个 **Overseer**（编排） + 4 个 **经典战术**（行情/infra）。

---

## 1. 总览表

| type | 代号 | 标签 | 组件 | 类别 |
|------|------|------|------|------|
| `runqueue` | WIDGET-Q | Run Queue | `RunQueuePanel` | Overseer |
| `daily` | WIDGET-D | Daily Digest | `DailyDigestPanel` | Overseer |
| `activerun` | WIDGET-R | Active Run | `ActiveRunPanel` | Overseer |
| `daemon` | WIDGET-S | 24/7 Scheduler | `OverseerDaemonPanel` | Overseer |
| `mission` | WIDGET-M | Mission Board | `MissionBoardPanel` | Overseer |
| `promote` | WIDGET-P | Promote | `PromotePanel` | Overseer |
| `market` | WIDGET-A | Alpha Market | `AlphaMarketIngestor` | 战术 |
| `github` | WIDGET-B | GitHub Radar | `GitHubRadar` | 战术 |
| `infra` | WIDGET-C | Infrastructure | `InfraTelemetry` | 战术 |
| `appslot` | WIDGET-D2 | App Integration | `AppIntegrationSlot` | 战术 |

> **代号说明**：`daily` 占用 **WIDGET-D**；`appslot` 为 **WIDGET-D2**（避免与 Daily 冲突）。

未知 `widgetType` 经 `normalizeWidgetType()` 回退为 `runqueue`。

---

## 2. Overseer Widgets

### WIDGET-Q — Run Queue

- **文件**：`RunQueuePanel.tsx`  
- **数据**：`queue/now.yaml` 快照（Tauri 读 Workbench）  
- **用途**：目视当前 implement/review/verify 队列  

### WIDGET-D — Daily Digest

- **文件**：`DailyDigestPanel.tsx`  
- **数据**：`daily/YYYY-MM-DD.md`  
- **用途**：日计划 /  evening rollup 摘要  

### WIDGET-R — Active Run

- **文件**：`ActiveRunPanel.tsx`  
- **能力**：Spawn Dry / Spawn Live、Kill、events tail  
- **依赖**：`orchestrator-client` → `spawn_agent_run`  
- **Dry**：不调用 API，写 events + orchestrator `done`  
- **Live**：需 `CURSOR_API_KEY`  

### WIDGET-S — 24/7 Scheduler

- **文件**：`OverseerDaemonPanel.tsx`  
- **能力**：Start/Stop `scheduler-daemon.js`  
- **状态**：`state/scheduler.json` + `daemon.pid`  
- **仅 Tauri**：浏览器 dev 无 daemon 进程  

### WIDGET-M — Mission Board

- **文件**：`MissionBoardPanel.tsx`  
- **数据**：`missions/*/progress.md` 解析  
- **显示**：phase id、goal、queued/done  

### WIDGET-P — Promote

- **文件**：`PromotePanel.tsx`  
- **能力**：列出 `staging/`，规则化复制到 Vault  
- **门禁**：`promote.require_human`  

---

## 3. 战术 Widgets

### WIDGET-A — Alpha Market

- **文件**：`AlphaMarketIngestor.tsx` → `MarketHubPanel` / `SymbolDetailPanel`  
- **模式**：顶栏 LIVE / MOCK（`juno-hud-prefs.marketDataMode`）  
- **LIVE**：dev 下 `/api/market/*` → `lib/market/live/*`；Tauri 静态包无 API → 用 MOCK 或外置代理  
- **交互**：同标的弹出窗去重、`stackOrder` 堆叠  

### WIDGET-B — GitHub Radar

- **文件**：`GitHubRadar.tsx`  
- **数据**：Mock WebSocket（待 GitHub API）  

### WIDGET-C — Infrastructure

- **文件**：`InfraTelemetry.tsx`  
- **数据**：Tauri `get_jupiter_telemetry` 或 mock  
- **Hub**：`jupiter-telemetry-hub.ts` 多窗共享  

### WIDGET-D2 — App Integration

- **文件**：`AppIntegrationSlot.tsx`  
- **状态**：MBT.AI iframe 占位  

---

## 4. 默认布局 Preset

**Overseer Quad**（`src/lib/layout/presets.ts`）：

- Run Queue、Daily、Daemon、Active Run  
- Mission Board、Promote  
- 可选 Infra  

经典 **Default Quad**：Market + GitHub + Infra + App Slot。

---

## 5. 面板通用交互

| 能力 | 模块 |
|------|------|
| 12×24 网格、允许重叠 | `LayoutCanvas.tsx` |
| 全局 FIT 缩放 | `HudViewport.tsx` |
| 窗内 contentZoom | `panel-zoom.ts` |
| 1/4 \| 1/2 \| FULL | `panel-preset.ts` |
| 弹出窗去重 | `layout-store.spawnMarketSymbolPanel` |

持久化：`juno-layout-store` **v6**。

---

## 6. Tauri IPC 完整表

| Command | 参数 | 返回 | 用途 |
|---------|------|------|------|
| `get_hud_system_snapshot` | — | cpu/ram | 顶栏系统指标 |
| `get_jupiter_telemetry` | — | node/ssh/thermal/npu/latency | Infra Widget |
| `spawn_agent_run` | manifestPath, dryRun? | runId, pid, status | Active Run |
| `kill_agent_run` | — | — | 终止子进程 |
| `read_run_events` | runId, maxLines? | lines[] | events tail |
| `get_scheduler_status` | — | enabled, lastAction, … | Daemon 面板 |
| `start_scheduler_daemon` | — | SchedulerStatus | 启动 daemon |
| `stop_scheduler_daemon` | — | — | 停止 daemon |
| `get_missions_snapshot` | — | MissionSummary[] | Mission Board |
| `list_staging_entries` | — | StagingEntry[] | Promote |
| `list_promote_rules` | — | PromoteRule[] | Promote |
| `promote_to_vault` | ruleId, relativePath | PromoteResult | 复制到 Vault |

前端桥接：`src/lib/workbench/orchestrator-client.ts`

---

## 7. 开发约定

- 样式仅经 `@/components/ui`  
- Widget props：`WidgetPanelProps { panelId }`  
- 新 Overseer 能力优先走 Tauri + Workbench 文件，不硬编码路径  
- 测试：相关逻辑放 `src/lib/`，Vitest 覆盖  

产品愿景见 [whitepaper.md](./whitepaper.md)；运维见 [maintenance.md](./maintenance.md)。
