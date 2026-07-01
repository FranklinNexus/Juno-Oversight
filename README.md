# Juno Oversight HUD

高信息密度、机构终端风格的战术看板（Next.js 16 + Tauri 2 + Juno Overseer 编排）。

## 文档

- **[Wiki 索引（120%）](./wiki/README.md)**
- [产品白皮书](./wiki/whitepaper.md) · [Widget 参考](./wiki/widgets.md)
- [Orchestrator](./wiki/orchestrator.md) · [Agent Workbench](./wiki/workbench.md)
- [维护手册](./wiki/maintenance.md) · [Smoke Loop](./wiki/smoke-loop.md)
- [Overseer 质量门禁](./wiki/overseer-quality.md)（**长任务 / Review 权威**）

## 运行

```bash
pnpm install
pnpm dev              # 浏览器 HUD
pnpm tauri:dev        # 桌面壳 + Workbench 快照（需 Node ≥ 22.13）
pnpm test
pnpm lint
pnpm build            # 静态 export → out/（Tauri 打包前置）
pnpm verify:desktop   # test + lint + build + orchestrator + cargo check
pnpm loop:smoke       # 最小 loop 本地跑通
pnpm queue:restore-literature   # 文献 Mission backlog → now
```

初始化 Workbench（仅需一次）：

```powershell
.\scripts\scaffold-workbench.ps1
node scripts/sync-workbench-hooks.mjs   # 同步 Vault / destructive 防火墙 hooks
```

Orchestrator（Cursor SDK，需 `CURSOR_API_KEY`）：

```powershell
.\scripts\use-node22.ps1
pnpm orchestrator:build
pnpm tauri:dev
# Active Run → Spawn Dry / Spawn Live
```

## 长任务 / 24/7 无人值守

```text
queue/now.yaml → Scheduler Daemon → spawn-run（≤25min/slot）
      ↓                              ↓
 checkpoint.md  ←──────────  events.jsonl
      ↓
 REVIEW_VERDICT / VERIFY_REPORT → resolveQueueAdvance → 出队
      ↓
 Promote → Vault（人工门禁）
```

1. 任务写在 `E:\AgentWorkbench\queue\now.yaml`（implement ↔ review ↔ verify 交替）
2. **24/7 Scheduler** 面板 → Start Daemon（`state/scheduler.json` 的 `enabled` 控制）
3. Agent 更新 `runs/<id>/checkpoint.md`；implement 完成需 `STATUS: COMPLETE`
4. **Promote** 面板把 `staging/` 复制进 Obsidian Vault

可选 `provider: api_token` + `.env.local` 中 `OPENAI_API_KEY`。

桌面发布：`pnpm build` → `pnpm tauri build`（见 [维护手册](./wiki/maintenance.md)）。

- 主界面：http://localhost:3000
- 组件目录（仅 dev）：http://localhost:3000/dev/components

## 能力概览

- 多窗网格、Omni-Surveillance / Deep Focus、LIVE/MOCK 行情
- **Overseer Widgets**：Run Queue、Daily、Active Run、Scheduler、Mission Board、Promote
- 经典 Widget：Market、GitHub、Infra、App Slot
- `.cursor/hooks`：Vault 防火墙 + **destructive-ops 防火墙**（见 `wiki/overseer-quality.md` §11）

详见 [wiki/whitepaper.md](./wiki/whitepaper.md)。
