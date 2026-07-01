# Juno Oversight — 维护手册

**最后更新**：2026-07-01（第六轮 — Overseer 对齐）

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
  app/                 # Next 路由、globals.css（网格/画布样式）
  components/
    dashboard/         # HudViewport、LayoutCanvas、PanelWindow、顶栏
    widgets/           # Overseer + 经典 Widget（见 widget-registry）
    market/            # 行情 Hub、详情、图表
  lib/
    workbench/         # orchestrator-client、types、测试
  app/api/market/      # （已移除）静态 export 不含 API 路由；LIVE 走 lib/market/live
    ui/                # HUD UI Kit
  hooks/
  lib/
    layout/            # 网格常量、clamp、preset 匹配、contentZoom、size 动画
    mock-feed-connection.ts
    jupiter-telemetry-hub.ts
    market/sanitize-watchlist.ts
  mocks/
  store/               # layout-store (persist v3)、hud-store、market-store
src-tauri/
scripts/free-port.mjs
out/                   # 仅 pnpm build 生成；勿提交 git
wiki/
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

| Command | 返回 |
|---------|------|
| `get_hud_system_snapshot` | `cpuPct`, `ramMb`, `ramTotalMb` |
| `get_jupiter_telemetry` | `node`, `sshConnected`, `thermalC`, `npuPct`, `latencyMs`（当前为 stub） |

前端 Hub：

- `useRuntimeHudMetrics` — Tauri 可用时不跑 mock CPU 定时器；后台 tab 暂停轮询
- `jupiter-telemetry-hub` — 多 Infra 窗共享；监听全局 `mode` 切换轮询间隔

---

## 7. 行情数据（LIVE / MOCK）

### 7.1 顶栏切换

- **LIVE**（默认）：`useLiveMarketFeed` 轮询 `GET /api/market/quotes?symbols=...`（2.5–4s）
- **MOCK**：`useMockWebSocket` + `generateMarketBatch`

| 市场 | LIVE 现价/K线 | 盘口 |
|------|----------------|------|
| Crypto | Binance REST | Binance depth（列表 ≤3 标的时） |
| US / HK / A股 | Yahoo Finance v7 / v8 | 合成五档（暂无 L2 API） |

K 线：`GET /api/market/klines?symbol=&timeframe=` → `MarketTradingChart`。

**限制**：`pnpm build` 静态导出**无** `/api/*`；Tauri 发布包需外置代理或继续用 MOCK。见 `.env.example` 中 `NEXT_PUBLIC_MARKET_API_BASE`。

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
| `manifest-prompt.test.ts` | prompt 注入含 §11 |
| `orchestrator-isolation.test.ts` | Workbench/Vault 隔离 |

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
| **按下瞬间窗体下跳** | RGL `createScaledStrategy` 的 `calcDragPosition` 用视口坐标 | 用 `createHudScaledStrategy`（有 scale、无 calcDragPosition） |
| **拖拽全程错位** | 全局缩放未校正 | `transform`+宽高补偿 + `createHudScaledStrategy(uiScale)` |
| **hydration 警告 `trancy-version`** | 浏览器扩展（Trancy 等）改写 `<html>` | 非应用 bug；已 `suppressHydrationWarning`；可禁用扩展验证 |
| 画布粗滚动条闪烁 | `overflow:auto` 与缩放抢宽度 | 隐藏滚动条、`overflow-x:hidden`；高度仅 RGL `autoSize` |
| 标题栏滚轮无法滚盘口 | 标题栏 wheel 用于缩放/调格 | 在窗体 **内容区** 滚轮滚动列表 |
| **两个同标的弹出窗** | 旧版每次 spawn 都新建 | 刷新后 migrate 去重；↗/⠿ 会置顶已有窗 |
| LIVE 行情失败 | 网络无法访问 Binance/Yahoo | 切 MOCK；国内可能需要代理 |
| `formatVolume24h` 重复 import | 合并 import 时残留 | 只保留一行 `@/lib/format` import |

---

## 10. 变更记录

### 2026-07-01（第六轮 — Wiki/代码对齐 + 安全）

- **Scheduler** 接入 `evaluateCompletedRun`、`shouldSkipSpawn`；不再启动时强制 `enabled: true`
- **Hooks**：`destructive-ops-gate.mjs`；`sync-workbench-hooks.mjs`
- **Wiki**：`overseer-quality.md` §7–§11；README 去重；移除 `/api/market`（静态 export）
- **默认布局**：Overseer Quad（runqueue / daily / daemon / activerun / mission / promote）

### 2026-06-02（第五轮 c — 主动 code review 修补）

- **点击行情行 / 搜索结果** → `useFocusSymbol` 打开或置顶详情窗（不再只写 `selectedSymbol`）
- 自选上限统一 **24**（`WATCHLIST_MAX`）；搜索支持 **中文名**（如「腾讯」）
- 去掉未实现的「深度」Tab（与订单表重复）
- 详情窗 LIVE 失败提示；`useElementHeight` 回调 ref 修复首帧高度为 0
- K 线 LIVE 数据到达后再次 `scrollToRealTime`

### 2026-06-02（第五轮 c — 主动 code review 修补）

- **点击行情行 / 搜索结果** → `useFocusSymbol` 打开或置顶详情窗（不再只写 `selectedSymbol`）
- 自选上限统一 **24**（`WATCHLIST_MAX`）；搜索支持 **中文名**（如「腾讯」）
- 去掉未实现的「深度」Tab（与订单表重复）
- 详情窗 LIVE 失败提示；`useElementHeight` 回调 ref 修复首帧高度为 0
- K 线 LIVE 数据到达后再次 `scrollToRealTime`

### 2026-06-02（第五轮 b — 详情窗渐进布局）

- 切换 **1m/15m/1H…** 后 K 线 `scrollToRealTime()` 右对齐（`fixRightEdge`）
- 详情窗按高度 **渐进显示**：K线 → MACD → 订单表（不够高则整块隐藏，不裁切）
- `symbol-detail-layout.ts` / `useElementHeight`

### 2026-06-02（第五轮 b — 详情窗渐进布局）

- 切换 **1m/15m/1H…** 后 K 线 `scrollToRealTime()` 右对齐（`fixRightEdge`）
- 详情窗按高度 **渐进显示**：K线 → MACD → 订单表（不够高则整块隐藏，不裁切）
- `symbol-detail-layout.ts` / `useElementHeight`

### 2026-06-02（第五轮 — LIVE 行情 + 弹出窗）

- **LIVE/MOCK** 顶栏切换；`juno-hud-prefs.marketDataMode`
- **`/api/market/quotes`**、**`/api/market/klines`**（仅 dev）
- Binance（Crypto）+ Yahoo（US/HK/A）；`lib/market/live/*`
- 弹出窗：**同标的去重**、右侧 5×14、`stackOrder` 堆叠、整条标题栏拖拽
- `MarketTradingChart` + `payload.ts` 类型统一
- `.env.example`

### 2026-06-02（第四轮 — 布局/缩放/滚动）

- **全局缩放**：`transform` + 宽高补偿 + RGL `transformScale`（`zoom`  alone 会导致拖拽错位）
- **拖拽**：仅 `onDragStop` / `onResizeStop` 落盘
- **画布**：24 行网格；滚动条隐藏；`overflow-x: hidden`；纵向滚轮平移
- **窗交互**：`contentZoom` persist **v3**；`panel-zoom` / `panel-preset` / `size-animation` 拆分
- **测试**：`panel-zoom.test.ts`；`clamp-panel` 对齐 24 行
- **脚本**：`predev` + `scripts/free-port.mjs`；`pnpm preview` 替代 `next start`

### 2026-06-02（窗口交互）

- 标题栏 **滚轮**：窗内内容缩放（75%–150%）
- **Shift + 滚轮**：格高；**Ctrl + 滚轮**：格宽
- **1/4 / 1/2 / FULL**：过渡动画 + 预设高亮

### 2026-06-02（第三轮）

- **修复**：`output: "export"` 仅在 production `next build` 启用
- **新增**：`pnpm clean`；build 前自动 clean
- Mock 按 socket 实例注册；Tauri `frontendDist: ../out`

### 2026-06-02（第二轮 / 首轮）

- market-store v1；ErrorBoundary；Jupiter 全局 mode；UI Kit、wiki 初版

**待办**：真实行情 / GitHub / Jupiter SSH；Widget D iframe；E2E；Firefox 下 `zoom` 降级方案（若需）

---

## 11. 贡献约定

- 样式走 `@/components/ui`
- 新 Widget 只改 `widget-registry.tsx`
- 持久化变更必须 `version` + `migrate`
- 布局/缩放逻辑放 `src/lib/layout/`，避免堆在组件内
- 产品 → `whitepaper.md`；运维 / 排错 → 本文件
