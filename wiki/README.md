# Juno Oversight Wiki

**120% 覆盖**：产品、运维、编排、Workbench、Widget、质量门禁、试跑 — 与代码同步至 **2026-07-01**。

---

## 文档地图

| 文档 | 读者 | 内容 |
|------|------|------|
| [whitepaper.md](./whitepaper.md) | 产品 / 新成员 | 愿景、10 Widget、架构、LIVE/MOCK、路线图 |
| [widgets.md](./widgets.md) | 前端 | WIDGET-Q～D2、Tauri IPC 全表、布局 preset |
| [orchestrator.md](./orchestrator.md) | 编排 | scheduler、spawn-run、出队、provider |
| [workbench.md](./workbench.md) | 运维 | AgentWorkbench 目录、Mission、prompts、state |
| [overseer-quality.md](./overseer-quality.md) | Reviewer | **权威**：REVIEW_VERDICT、Verify、§11 防火墙 |
| [smoke-loop.md](./smoke-loop.md) | 试跑 | 最小 implement→review→verify |
| [architecture-loop.md](./architecture-loop.md) | 自指 | `pnpm loop:smoke` / meta mission |
| [juno-agent-architecture.md](./juno-agent-architecture.md) | 架构 | 100 篇文献 → Juno 分层 + 缺口 |
| [juno-agi-north-star.md](./juno-agi-north-star.md) | AGI | 1000 篇 → 初步 AGI 栈（进行中） |
| [juno-bounded-autonomy.md](./juno-bounded-autonomy.md) | 自决策 | 带限制的自我迭代策略 |
| [agent-literature-index.md](./agent-literature-index.md) | 文献 | 100 篇总表与主题分布 |
| [maintenance.md](./maintenance.md) | 日常 | 命令、目录、行情、测试、排错 |

---

## 按场景跳转

| 我想… | 去看 |
|-------|------|
| 恢复文献 Mission 队列 | `pnpm queue:restore-literature` · [architecture-loop §5](./architecture-loop.md#5-文献-mission-恢复) |
| 读 Agent 文献架构归纳 | [juno-agent-architecture.md](./juno-agent-architecture.md) · [agent-literature-index.md](./agent-literature-index.md) |
| 窗口只显示 Internal Server Error | [maintenance §3、§9](./maintenance.md#3-next-配置要点必读) |
| 启动 24/7 无人值守 | [README §长任务](../README.md) + [orchestrator §7](./orchestrator.md#7-常用命令) |
| 跑最小 loop 验证门禁 | [smoke-loop.md](./smoke-loop.md) |
| 写 Review / Verify checkpoint | [overseer-quality §2、§8、§9](./overseer-quality.md#2-review-判决固定格式) |
| 加新 Widget | [widgets §7](./widgets.md#7-开发约定) |
| 理解 queue / runs | [workbench §1–§6](./workbench.md) |
| LIVE 行情为何不工作 | [whitepaper §4](./whitepaper.md#4-行情-live--mock) + [maintenance §7](./maintenance.md#7-行情数据-live--mock) |
| 避免删库事故 | [overseer-quality §11](./overseer-quality.md#11-破坏性操作防火墙致命级) |

---

## 仓库内其他文档

- 应用 README：`../README.md`
- UI Kit：`../src/components/ui/README.md`
- 组件预览（仅 dev）：http://localhost:3000/dev/components

---

## 版本约定

Wiki 章节含 **最后更新** 日期。代码行为以 `orchestrator/src/`、`src/lib/layout/widget-registry.tsx` 为准；若冲突，以代码 + 本 Wiki 第七轮为准并提 issue 修文档。
