# Juno Oversight — 维护手册

**最后更新**：2026-06-02（第三轮）

---

## 1. 环境要求

| 工具 | 版本建议 |
|------|----------|
| Node.js | 20+ |
| pnpm | 9+ |
| Rust | 1.77+（仅 `tauri:dev` / 打包） |

---

## 2. 常用命令

```bash
pnpm install          # 安装依赖
pnpm dev              # 浏览器 / Tauri 开发（走 .next，非静态导出）
pnpm tauri:dev        # 桌面壳 + Next 热更新（需先能访问 localhost:3000）
pnpm clean            # 删除 out/ 与 .next/（排错时用）
pnpm build            # clean + 静态导出到 out/（仅生产构建启用 export）
pnpm build:desktop    # 同 pnpm build
pnpm lint             # ESLint
pnpm test             # Vitest 单元测试
```

### 开发地址

| URL | 说明 |
|-----|------|
| http://localhost:3000 | 主 HUD（`pnpm dev`） |
| http://localhost:3000/dev/components | UI 组件目录（**仅 development**） |

若 3000 被占用，Next 会换端口；此时需关掉旧进程或改 Tauri `devUrl`。

### 桌面打包（Tauri）

1. `pnpm build` → 仅 **`next build`（NODE_ENV=production）** 时写入 `out/index.html`
2. `src-tauri/tauri.conf.json` → `frontendDist: "../out"`
3. `cd src-tauri` 或根目录 `pnpm tauri build`

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
  app/                 # Next 路由
  components/
    dashboard/         # 顶栏、网格、PanelWindow、WidgetShell、ErrorBoundary
    widgets/           # Widget A–D
    market/            # 盘口、自选
    ui/                # HUD UI Kit
  hooks/
  lib/
    mock-feed-connection.ts
    jupiter-telemetry-hub.ts
    market/sanitize-watchlist.ts
  mocks/
  store/
src-tauri/
out/                   # 仅 pnpm build 生成；勿提交 git
wiki/
```

---

## 5. 本地存储键

| Key | 内容 |
|-----|------|
| `juno-layout-store` | 面板布局（v2 migrate） |
| `juno-market-store` | 自选（v1，无效 symbol 自动剔除） |

清除：DevTools → Application → Local Storage，或 `pnpm clean` 后仅清站点数据。

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

## 7. Mock 数据

### 7.1 连接态

每 Socket 实例：`feedId + useId()`（如 `market:_R_abc_`）。顶栏 LIVE = 任一实例存活；LAT = 各实例 max。

### 7.2 行情

模块级 `Map` 跨 HMR 保留；异常时硬刷新。Ticker `key={symbol}`。

---

## 8. 测试

```bash
pnpm test
```

| 文件 | 覆盖 |
|------|------|
| `format.test.ts` | 格式化 |
| `clamp-panel.test.ts` | 网格 clamp |
| `mock-feed-connection.test.ts` | 多实例连接 |
| `sanitize-watchlist.test.ts` | 自选清洗 |

---

## 9. 排错

| 现象 | 可能原因 | 处理 |
|------|----------|------|
| **Internal Server Error**（白底一行字） | dev 时误开 `output: "export"`；或 3000 上跑着坏掉的旧 Next | `pnpm clean` → 杀旧 node → `pnpm dev` |
| Tauri 开发窗口报错但浏览器正常 | `devUrl` 端口不对（3000 vs 3001） | 只保留一个 `pnpm dev` |
| Tauri 白屏 | 未 build 或 `out/` 无 `index.html` | `pnpm build` 后检查 `out/index.html` |
| `out/dev/` 目录存在 | 曾在 export 模式下跑过 dev | `pnpm clean` 后按上文流程重来 |
| 顶栏 DISCONNECTED | 所有 Mock 实例已卸载 | 确认至少一个行情/GitHub 窗 |
| 布局错乱 | localStorage 损坏 | Reset 或删 `juno-layout-store` |
| `/dev/components` 在生产包可打开 | 静态导出仍生成该 HTML | 勿依赖；生产应只加载 `/` |

---

## 10. 变更记录

### 2026-06-02（第三轮）

- **修复**：`output: "export"` 仅在 `next build`（production）启用；dev 恢复 `.next`
- **新增**：`pnpm clean`；`pnpm build` 前自动 clean
- **文档**：本排错章节（Internal Server Error）

### 2026-06-02（第二轮）

- Mock 按 socket 实例注册；Tauri `frontendDist: ../out`
- market-store v1；ErrorBoundary remount；Jupiter 全局 mode
- GitHub Focus；最大化锁定拖拽

### 2026-06-02（首轮）

- UI Kit、布局持久化、Tauri 指标、wiki 初版

**待办**：真实行情 / GitHub / Jupiter SSH；Widget D iframe；E2E

---

## 11. 贡献约定

- 样式走 `@/components/ui`
- 新 Widget 只改 `widget-registry.tsx`
- 持久化变更必须 `version` + `migrate`
- 产品 → `whitepaper.md`；运维 / 排错 → 本文件
