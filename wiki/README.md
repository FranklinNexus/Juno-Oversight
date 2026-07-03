# Juno Oversight Wiki

**与代码同步至 2026-07-03** — 产品、编排、Workbench、质量门禁、AGI loop、Von Neumann v1、Hardening COMPLETE。

---

## 文档地图

| 文档 | 读者 | 内容 |
|------|------|------|
| [**juno-architecture.md**](./juno-architecture.md) | **架构** | **系统总览、模块地图、状态文件、planner、安全边界** |
| [whitepaper.md](./whitepaper.md) | 产品 / 新成员 | 愿景、10 Widget、路线图 |
| [architecture-loop.md](./architecture-loop.md) | 架构 | smoke → P0–P2 → AGI 1000 → 公理之书 |
| [juno-agi-north-star.md](./juno-agi-north-star.md) | AGI | 1000 篇 synthesis、初步 AGI 栈 |
| [juno-von-neumann-unit.md](./juno-von-neumann-unit.md) | 进化 v0 | 冯·诺依曼自指单元 · fitness · 突变白名单 |
| [juno-bounded-autonomy.md](./juno-bounded-autonomy.md) | 自决策 | 日限额、决策流、daemon |
| [juno-axiom-book-experiment.md](./juno-axiom-book-experiment.md) | 写书 | overnight 公理之书实验 |
| [juno-self-optimize.md](./juno-self-optimize.md) | 自优化 | quality-gate、REVISE、MCP、workflow |
| [api-gateway.md](./api-gateway.md) | 运维 | 限速、配额、容量估算 |
| [orchestrator.md](./orchestrator.md) | 编排 | scheduler、spawn-run、出队 |
| [workbench.md](./workbench.md) | 运维 | AgentWorkbench 目录、Mission |
| [overseer-quality.md](./overseer-quality.md) | Reviewer | **权威**：REVIEW_VERDICT、§11 防火墙 |
| [juno-agent-architecture.md](./juno-agent-architecture.md) | 架构 | 100 篇文献 → 分层 |
| [agent-literature-index.md](./agent-literature-index.md) | 文献 | 100 篇总表 |
| [widgets.md](./widgets.md) | 前端 | WIDGET-Q～D2、Tauri IPC |
| [smoke-loop.md](./smoke-loop.md) | 试跑 | 最小 implement→review→verify |
| [maintenance.md](./maintenance.md) | 日常 | 命令、排错、打包 |

---

## 按场景跳转

| 我想… | 去看 |
|-------|------|
| **理解整体架构** | [**juno-architecture.md**](./juno-architecture.md) |
| 从零跑通最小 loop | [smoke-loop.md](./smoke-loop.md) · `pnpm loop:smoke` |
| 1000 篇 AGI 文献无人值守 | [juno-bounded-autonomy.md](./juno-bounded-autonomy.md) · `pnpm agi:daemon` |
| overnight 写书 | [juno-axiom-book-experiment.md](./juno-axiom-book-experiment.md) · `pnpm book:daemon` |
| 修书稿 spaced-bold / quality | [juno-self-optimize.md](./juno-self-optimize.md) · `pnpm self:optimize` |
| 跑 Von Neumann fitness | [juno-von-neumann-unit.md](./juno-von-neumann-unit.md) · `pnpm evolution:tick` |
| 防 API 429 | [api-gateway.md](./api-gateway.md) · `pnpm api:quota` |
| 配 MCP / dev 分支 | [juno-self-optimize.md §6](./juno-self-optimize.md#6-mcp-与开发版) · `config/mcp-servers.example.json` |
| 启动 24/7 Scheduler | [README §长任务](../README.md) · [orchestrator §7](./orchestrator.md) |
| 写 Review checkpoint | [overseer-quality §2](./overseer-quality.md#2-review-判决固定格式) |
| 避免删库 / Vault 事故 | [overseer-quality §11](./overseer-quality.md#11-破坏性操作防火墙致命级) |
| LIVE 行情（dev） | [maintenance §7](./maintenance.md#7-行情数据-live--mock) |

---

## 配置示例

仓库 `config/` → 复制到 Workbench，见 [config/README.md](../config/README.md)。

---

## 版本约定

行为以 `orchestrator/src/`、`scripts/` 为准；文档冲突时以代码 + 本 Wiki 为准。
