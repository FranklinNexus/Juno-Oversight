# Juno Oversight

**Juno Oversight HUD** — 机构终端风格战术看板（Next.js 16 + Tauri 2）  
**Juno Overseer** — 长任务编排层：`implement → review → verify`，支持 24/7 Scheduler、bounded autonomy、API 限速与自主优化。

> 目标：用同一套门禁跑 smoke、文献 synthesis、AGI 架构迭代、overnight 写书——人定 north-star，Juno 跑 slot，人验收 promote。

---

## 文档

| 文档 | 说明 |
|------|------|
| [Wiki 索引](./wiki/README.md) | 全文档地图 |
| [产品白皮书](./wiki/whitepaper.md) | 愿景、Widget、路线图 |
| [架构闭环](./wiki/architecture-loop.md) | smoke → P0–P2 → AGI 1000 → 公理之书 |
| [Bounded Autonomy](./wiki/juno-bounded-autonomy.md) | 受限自决策 |
| [API Gateway](./wiki/api-gateway.md) | 限速、配额、退避 |
| [Self-Optimize](./wiki/juno-self-optimize.md) | 质量 scan、REVISE 闭环、MCP |
| [维护手册](./wiki/maintenance.md) | 排错、打包、测试 |
| [Overseer 质量门禁](./wiki/overseer-quality.md) | REVIEW_VERDICT 权威 |

---

## 快速开始

### 1. 依赖

| 工具 | 版本 |
|------|------|
| Node.js | **≥ 22.13** |
| pnpm | 10+ |
| Rust | 1.77+（仅桌面 `tauri:dev` / 打包） |

### 2. 安装与 HUD

```bash
git clone https://github.com/FranklinNexus/Juno-Oversight.git
cd Juno-Oversight
pnpm install
pnpm dev                 # http://localhost:3000
pnpm test
```

### 3. 环境变量

```bash
cp .env.example .env.local
```

| 变量 | 必需 | 说明 |
|------|------|------|
| `CURSOR_API_KEY` | Live Agent | Cursor API（Composer spawn） |
| `AGENT_WORKBENCH_ROOT` | 是 | 运行时目录，默认 `E:\AgentWorkbench` |
| `JUNO_OVERSIGHT_ROOT` | 是 | 本仓库绝对路径 |
| `OPENAI_API_KEY` | 可选 | `provider: api_token` fallback |

**勿提交** `.env.local`（已在 `.gitignore`）。

### 4. 初始化 Agent Workbench（一次）

```powershell
.\scripts\scaffold-workbench.ps1
node scripts/sync-workbench-hooks.mjs
```

复制配置示例到 Workbench（见 [config/README.md](./config/README.md)）：

```powershell
Copy-Item config\api-limits.example.json E:\AgentWorkbench\config\api-limits.json
Copy-Item config\self-optimize.example.json E:\AgentWorkbench\config\self-optimize.json
Copy-Item config\mcp-servers.example.json E:\AgentWorkbench\config\mcp-servers.json
```

### 5. Orchestrator + 桌面

```bash
pnpm orchestrator:build
pnpm tauri:dev          # HUD + Workbench 快照 + Active Run 面板
```

Active Run → **Spawn Dry**（无 API）/ **Spawn Live**（需 `CURSOR_API_KEY`）。

---

## 能力概览

### HUD（前端）

- 多窗网格、Omni / Focus、LIVE/MOCK 行情（dev 经 `/api/market`）
- **Overseer Widgets**：Run Queue、Daily、Active Run、Scheduler、Mission Board、Promote
- 布局持久化、`contentZoom`、同标的弹出窗去重

### Overseer（编排）

```text
queue/now.yaml → Scheduler / loop scripts → spawn-run
      ↓                    ↓
 checkpoint.md      api-gateway（RPM/并发/日配额）
      ↓
 REVIEW_VERDICT → REVISE prepend → 下一 slot
      ↓
 Promote → Vault（人工门禁，默认 require_human）
```

- **Review 门禁**：`REVIEW_VERDICT` 机器可读；BLOCK 不出队
- **防火墙**：`.cursor/hooks` 拦截 Vault 读写与 destructive shell
- **Bounded autonomy**：`pnpm juno:daemon` 或 `pnpm autonomy:tick --execute` — mission-planner 自选下一任务（quality / hardening / AGI…）

---

## 命令速查

### 开发与质量

```bash
pnpm dev | build | test | lint
pnpm verify:desktop      # test + lint + build + orchestrator + cargo check
pnpm loop:smoke          # 最小三 slot 本地验证
pnpm orchestrator:build
pnpm api:quota           # API 配额与 mission 容量
```

### 自迭代（P0–P2）

```bash
pnpm loop:self-iterate-run
pnpm loop:self-iterate-p1-run
pnpm loop:self-iterate-p2-run
```

### AGI 文献（1000 篇）

```bash
pnpm queue:agi-literature
pnpm agi:loop            # 单次推进
pnpm agi:daemon          # 后台无人值守
pnpm agi:daemon:stop
```

### 公理之书

```bash
pnpm queue:axiom-book
pnpm book:loop
pnpm book:daemon
pnpm book:quality-loop    # 程序化 quality REVISE
```

### 自主优化

```bash
pnpm self:optimize        # scan + rubric patch + workflow + MCP hints
pnpm autonomy:tick        # 决策预览（mission-planner）
pnpm autonomy:tick --execute
pnpm juno:daemon          # 后台自主循环（推荐）
```

---

## 最小 AGI Loop（推荐路径）

```text
loop:smoke → loop:meta-run
  → loop:self-iterate-p2-run
  → queue:agi-literature → agi:daemon（1000 篇）
  → queue:axiom-book → book:daemon（overnight 写书）
  → self:optimize → book:quality-loop（修 spaced-bold 等）
```

详见 [architecture-loop.md](./wiki/architecture-loop.md)。

---

## 目录结构

```text
src/                 Next.js HUD + Widgets
orchestrator/src/    Scheduler、spawn-run、review-loop、api-gateway、self-optimize
scripts/             loop runners、bootstrap、daemon
wiki/                产品与运维文档
config/              Workbench 配置示例（复制到 AgentWorkbench/config/）
.cursor/hooks/       Vault + destructive-ops 防火墙
```

运行时产物在 **AgentWorkbench**（不进 git）：`queue/`、`runs/`、`missions/`、`state/`。

---

## 安全与边界

| 规则 | 机制 |
|------|------|
| 禁止读写 Obsidian Vault | `vault-gate` hook |
| 禁止 `git reset --hard` 等 | `destructive-ops-gate` |
| Promote 进 Vault | 默认 `require_human: true` |
| 自主迭代日上限 | `bounded-autonomy.json` |
| Live API burst | `api-gateway` + `api-limits.json` |

---

## 发布桌面版

```bash
pnpm build              # 静态 export → out/
pnpm tauri build
```

静态包**不含** `/api/market`；LIVE 行情需 MOCK 或 Phase 3 外置代理（见 [maintenance.md](./wiki/maintenance.md)）。

---

## 许可与仓库

- GitHub: [FranklinNexus/Juno-Oversight](https://github.com/FranklinNexus/Juno-Oversight)
- 问题与 PR 欢迎；行为以 `orchestrator/src/` + Wiki 为准
