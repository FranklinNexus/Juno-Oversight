<p align="center">
  <img src="docs/assets/juno-overseer-banner.png" alt="Juno Overseer — Long-horizon agent orchestrator on Cursor" width="720" />
</p>

<p align="center">
  <strong>Juno Oversight</strong> — 机构终端风格 HUD + 长任务 Agent 编排层<br/>
  <em>人定 North Star · Juno 跑 slot · 人验收 Promote</em>
</p>

<p align="center">
  <a href="https://github.com/FranklinNexus/Juno-Oversight">GitHub</a> ·
  <a href="./wiki/README.md">Wiki</a> ·
  <a href="./wiki/whitepaper.md">白皮书</a> ·
  <a href="./wiki/architecture-loop.md">架构闭环</a>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Node-%3E%3D22.13-339933?logo=node.js&logoColor=white" alt="Node" />
  <img src="https://img.shields.io/badge/Next.js-16-000000?logo=next.js&logoColor=white" alt="Next.js" />
  <img src="https://img.shields.io/badge/Tauri-2-24C8DB?logo=tauri&logoColor=white" alt="Tauri" />
  <img src="https://img.shields.io/badge/tests-98_passing-success" alt="tests" />
</p>

---

## 这是什么

**Juno Oversight** 把 Cursor Agent 从「单次对话」升级为 **可审计的长时任务系统**：

| 层 | 职责 |
|----|------|
| **HUD** | 战术看板 — Run Queue、Active Run、Scheduler、Mission Board、Promote |
| **Overseer** | 编排内核 — `implement → review → verify`，checkpoint 跨 slot 记忆 |
| **AgentWorkbench** | 运行时状态 — queue、missions、runs（不进 git） |

同一套门禁可跑：smoke 验证 → P0–P2 自迭代 → **1000 篇 AGI 文献** → **overnight 写书** → 程序化 quality REVISE → Overseer 硬化。

<p align="center">
  <img src="docs/assets/juno-flow-diagram.png" alt="Juno orchestration flow" width="800" />
</p>

---

## 核心能力

<table>
<tr>
<td width="50%" valign="top">

### 编排与门禁

- **REVIEW_VERDICT** 机器可读 — BLOCK 不出队
- **scope-lock** 每 Mission 限定可改路径
- **Quality Gate** — spaced-bold、字数、公理引用（程序化 + LLM）
- **API Gateway** — RPM / 并发 / 日 token 预算

</td>
<td width="50%" valign="top">

### 自主与安全

- **Mission Planner** — 章程驱动，自选下一任务，无需逐条 assign
- **`pnpm juno:daemon`** — 后台 bounded autonomy 循环
- **Vault 防火墙** — `.cursor/hooks` 拦截 Obsidian 读写
- **Destructive ops gate** — 禁止 `rm -rf` / `git reset --hard` 等

</td>
</tr>
</table>

<p align="center">
  <img src="docs/assets/juno-hud-orbit.png" alt="Juno HUD orbit visualization" width="640" />
</p>

---

## 快速开始

### 1 · 克隆与安装

```bash
git clone https://github.com/FranklinNexus/Juno-Oversight.git
cd Juno-Oversight
pnpm install
pnpm dev          # http://localhost:3000
pnpm test         # 98 tests
```

| 工具 | 版本 |
|------|------|
| Node.js | **≥ 22.13** |
| pnpm | 10+ |
| Rust | 1.77+（仅 `tauri:dev` / 桌面打包） |

### 2 · 环境变量

```bash
cp .env.example .env.local
```

| 变量 | 必需 | 说明 |
|------|:----:|------|
| `AGENT_WORKBENCH_ROOT` | ✓ | 运行时目录，如 `E:\AgentWorkbench` |
| `JUNO_OVERSIGHT_ROOT` | ✓ | 本仓库绝对路径 |
| `CURSOR_API_KEY` | Live | Cursor Composer spawn |
| `OPENAI_API_KEY` | — | `provider: api_token` fallback |

> **勿提交** `.env.local`（已在 `.gitignore`）。

### 3 · 初始化 Workbench（一次）

```powershell
.\scripts\scaffold-workbench.ps1
node scripts/sync-workbench-hooks.mjs

# 复制配置示例 → AgentWorkbench/config/
Copy-Item config\api-limits.example.json       E:\AgentWorkbench\config\api-limits.json
Copy-Item config\self-optimize.example.json   E:\AgentWorkbench\config\self-optimize.json
Copy-Item config\mcp-servers.example.json     E:\AgentWorkbench\config\mcp-servers.json
Copy-Item config\autonomy-charter.example.json E:\AgentWorkbench\config\autonomy-charter.json
```

详见 [config/README.md](./config/README.md)。

### 4 · Orchestrator + 桌面 HUD

```bash
pnpm orchestrator:build
pnpm tauri:dev      # HUD + Workbench 快照 + Active Run 面板
```

Active Run → **Spawn Dry**（无 API）/ **Spawn Live**（需 `CURSOR_API_KEY`）。

---

## 让 Juno 自己动起来

复制 `config/autonomy-charter.example.json` 到 Workbench 后：

```bash
pnpm autonomy:tick              # 预览 mission-planner 决策
pnpm autonomy:tick --execute    # 执行一轮
pnpm juno:daemon                # 后台循环（推荐）
```

### 每日自动（刷满限额 + 隔离导出 + 清理）

```bash
Copy-Item config\daily-schedule.example.json E:\AgentWorkbench\config\daily-schedule.json
pnpm daily:juno                 # 立即跑一轮
pnpm daily:juno:install         # Windows 计划任务 07:00
```

导出到 **隔离目录**（默认 `E:\JunoDailyExport`），不写入 Vault。详见 [juno-daily-schedule.md](./wiki/juno-daily-schedule.md)。

Planner 优先级：quality scan → self-optimize → 队列头 → registry（P2 → AGI → 写书 → hardening…）。

---

## 命令速查

<details>
<summary><strong>开发与验证</strong></summary>

```bash
pnpm dev | build | test | lint
pnpm verify:desktop       # test + lint + build + orchestrator + cargo check
pnpm loop:smoke            # 最小三 slot 本地验证
pnpm orchestrator:build
pnpm api:quota             # API 配额与 mission 容量
```

</details>

<details>
<summary><strong>自迭代 P0–P2</strong></summary>

```bash
pnpm loop:self-iterate-run
pnpm loop:self-iterate-p1-run
pnpm loop:self-iterate-p2-run
```

</details>

<details>
<summary><strong>AGI 文献（1000 篇）</strong></summary>

```bash
pnpm queue:agi-literature
pnpm agi:loop
pnpm agi:daemon
pnpm agi:daemon:stop
```

</details>

<details>
<summary><strong>公理之书 + Quality</strong></summary>

```bash
pnpm queue:axiom-book
pnpm book:loop
pnpm book:daemon
pnpm book:quality-loop       # 程序化 REVISE（spaced-bold 等）
pnpm self:optimize           # scan + rubric + workflow + MCP
```

</details>

<details>
<summary><strong>Mission 硬化 · 清理 · 通用</strong></summary>

```bash
pnpm mission:loop            # generic Live slot（hardening 等）
pnpm queue:hardening           # 恢复 h07–h11
pnpm workbench:purge           # dry-run 清理 runs/staging
pnpm workbench:purge --execute --i-understand
pnpm queue:cleanup             # bootstrap 安全清理 mission
```

</details>

---

## 推荐路径：最小 AGI Loop

```text
loop:smoke
  → loop:meta-run
  → loop:self-iterate-p2-run
  → queue:agi-literature → agi:daemon        # 1000 篇
  → queue:axiom-book → book:daemon             # overnight 写书
  → juno:daemon                                # quality + hardening 自主推进
  → self:optimize → book:quality-loop
```

<p align="center">
  <img src="docs/assets/juno-architecture-loop.png" alt="Juno logo" width="200" />
</p>

完整链路见 [architecture-loop.md](./wiki/architecture-loop.md)。

---

## 目录结构

```text
src/                      Next.js HUD + Overseer Widgets
orchestrator/src/         Scheduler · spawn-run · review-loop · mission-planner
                          api-gateway · quality-gate · self-optimize · workbench-purge
scripts/                  loop runners · bootstrap · daemon
wiki/                     产品与运维文档
config/                   Workbench 配置示例
missions-templates/       Mission 脚手架（cleanup · hardening…）
docs/assets/              README 插图
.cursor/hooks/            Vault + destructive-ops 防火墙
```

**运行时**（`AgentWorkbench/`，不进 git）：`queue/` · `runs/` · `missions/` · `state/`

---

## 文档索引

| 文档 | 说明 |
|------|------|
| [Wiki 索引](./wiki/README.md) | 全文档地图 |
| [产品白皮书](./wiki/whitepaper.md) | 愿景、Widget、路线图 |
| [Workbench](./wiki/workbench.md) | 运行时目录与 Mission 生命周期 |
| [Overseer 质量门禁](./wiki/overseer-quality.md) | REVIEW_VERDICT 权威 |
| [API Gateway](./wiki/api-gateway.md) | 限速、配额、退避 |
| [Self-Optimize](./wiki/juno-self-optimize.md) | 质量 scan、REVISE 闭环 |
| [维护手册](./wiki/maintenance.md) | 排错、打包、测试 |

---

## 安全边界

| 规则 | 机制 |
|------|------|
| 禁止读写 Obsidian Vault | `vault-gate` hook |
| 禁止 destructive git / shell | `destructive-ops-gate` + `safety-doctrine` |
| Promote 进 Vault | 默认 `require_human: true` |
| 自主迭代日上限 | `state/bounded-autonomy.json` |
| Workbench 清理 | 仅 `runs/`、`staging/`；`--i-understand` 双确认 |
| Live API burst | `api-gateway` + `config/api-limits.json` |

---

## 桌面发布

```bash
pnpm build              # 静态 export → out/
pnpm tauri build
```

静态包不含 `/api/market`；LIVE 行情需 MOCK 或外置代理（见 [maintenance.md](./wiki/maintenance.md)）。

---

## 许可

MIT 风格开源协作 — 问题与 PR 欢迎于 [FranklinNexus/Juno-Oversight](https://github.com/FranklinNexus/Juno-Oversight)。  
行为以 `orchestrator/src/` 与 Wiki 为准。

<p align="center">
  <img src="docs/assets/juno-architecture-loop.png" alt="Juno" width="80" />
  <br/>
  <sub>Juno Overseer · Write · Review · Verify</sub>
</p>
