# Juno Oversight HUD

高信息密度、机构终端风格的战术看板（Next.js 16 + Tauri 2）。

## 文档

- **[Wiki 索引](./wiki/README.md)**
- [产品白皮书](./wiki/whitepaper.md)
- [维护手册](./wiki/maintenance.md)

## 运行

```bash
pnpm install
pnpm dev          # 浏览器（mock 数据）
pnpm tauri:dev    # 桌面壳 + 真实 Workbench 快照
pnpm test         # 单元测试
pnpm lint
pnpm build        # 静态导出到 out/（Tauri 打包前置）
```

初始化 Workbench 目录（仅需一次）：

```powershell
.\scripts\scaffold-workbench.ps1
```

Orchestrator（Cursor SDK 子进程，需 **Node ≥ 22.13** + `CURSOR_API_KEY`）：

```powershell
# 1) Node 22
.\scripts\use-node22.ps1

# 2) API Key — Cursor Dashboard → Integrations → 复制到 .env.local
#    CURSOR_API_KEY=cursor_...

pnpm orchestrator:build
pnpm tauri:dev
# Active Run → Spawn Dry（无 Key）或 Spawn Live（需 Key）

## 长任务 / 24/7 无人值守

```text
queue/now.yaml → Scheduler Daemon → spawn-run（≤25min/slot）
      ↓                              ↓
 checkpoint.md  ←──────────  events.jsonl（流式输出）
      ↓
 STATUS: COMPLETE → 出队 → Promote → Vault
```

1. `pnpm tauri:dev`
2. **24/7 Scheduler** 面板 → **Start Daemon**
3. 任务写在 `E:\AgentWorkbench\queue\now.yaml`
4. 跨 slot 续跑：Agent 更新 `runs/<id>/checkpoint.md`；完成后加一行 `STATUS: COMPLETE`
5. **Promote** 面板把 `staging/` 复制进 Obsidian Vault

可选 `api_token`：queue 项设 `provider: api_token`，`.env.local` 配 `OPENAI_API_KEY`。

## 长任务 / 24/7 无人值守

```text
queue/now.yaml → Scheduler Daemon → spawn-run（≤25min/slot）
      ↓                              ↓
 checkpoint.md  ←──────────  events.jsonl（流式输出）
      ↓
 STATUS: COMPLETE → 出队 → Promote → Vault
```

1. `pnpm tauri:dev`
2. **24/7 Scheduler** 面板 → **Start Daemon**
3. 任务写在 `E:\AgentWorkbench\queue\now.yaml`
4. 跨 slot 续跑：Agent 更新 `runs/<id>/checkpoint.md`；完成后加一行 `STATUS: COMPLETE`
5. **Promote** 面板把 `staging/` 复制进 Obsidian Vault

可选 `api_token`：queue 项设 `provider: api_token`，`.env.local` 配 `OPENAI_API_KEY`。
```

桌面发布：`pnpm build` 后执行 `pnpm tauri build`（见 [维护手册](./wiki/maintenance.md)）。

若窗口只显示 **Internal Server Error**：`pnpm clean` → 结束占用 3000 的旧 Node → `pnpm dev` 或 `pnpm tauri:dev`（见维护手册 §9）。

- 主界面：http://localhost:3000  
- 组件目录（仅开发）：http://localhost:3000/dev/components  

## 能力概览

- 多窗可拖拽网格（24 行、无可见画布滚动条）、`Omni-Surveillance` / `Deep Focus` 模式
- 窗体 1/4|1/2|FULL、标题栏滚轮缩放内容、Shift/Ctrl+滚轮调格位
- Widget：行情、GitHub 雷达、基础设施遥测、应用嵌入位
- 多市场自选（Crypto / US / HK / A股）、布局预设与本地保存（layout v3）
- HUD UI Kit、`/dev/components` 预览

详见 [wiki/whitepaper.md](./wiki/whitepaper.md)。
