# North Star — juno-daily-inbox-2026

**目标**：每天 0 点在 Obsidian Vault **`Juno/inbox/`**（隔离子目录）生成一份**给你定制的每日任务** Markdown；次日运行前**删除昨日**同目录下的任务文档。

## Vault 隔离规则

- **唯一可写根**：`{vault_path}/Juno/`（Workbench `config.yaml` → `vault_juno_root`）
- 禁止写 Vault 其他目录（`20_Projects/`、`学校/` 等只读，用于 i03 定制参考）
- 以后所有 Juno 产出进 `Juno/` 下子目录（每日任务 → `Juno/inbox/`）

## 完成定义

- [ ] `orchestrator/src/daily-inbox.ts` — 生成 + 删昨日 + `validateJunoVaultRoot`（仅允许 `{vault}/Juno/**`）
- [ ] `config/daily-inbox.example.json` + Workbench `config/daily-inbox.json`
- [ ] `pnpm daily:inbox` 可独立运行；`run-daily-juno.mjs` **开头**调用（先于 autonomy ticks）
- [ ] 输出：`E:/Obsidian Vault/Juno/inbox/YYYY-MM-DD-每日任务.md`
- [ ] 删除：仅删 `Juno/inbox/{yesterday}-每日任务.md`（不碰 `_profile.md`、`README.md`）
- [ ] i03 Live slot：读 Vault 近期笔记 + `Juno/inbox/_profile.md`，写入**个性化**任务节
- [ ] 单元测试 + verify slot PASS
- [ ] mission `STATUS: COMPLETE`

## 文档结构（生成模板）

```markdown
---
date: YYYY-MM-DD
tags: [juno, daily-inbox, 每日任务]
source: juno-daily-inbox
---

# 今日任务 · YYYY-MM-DD

> 由 Juno 生成；仅保留当日，明日自动删除。

## 给你的三件事（定制）

## Juno 系统面

## 可选跟进
```

## 与 Juno日报 的区别

| | Juno日报 | 每日 inbox |
|--|----------|------------|
| 位置 | 隔离 `JunoDailyExport/` | Vault **`Juno/inbox/`** |
| 受众 | 系统运维摘要 | **你**的待办 |
| 留存 | 30 天 | **1 天** |

## 命令

```bash
pnpm daily:inbox
pnpm daily:juno
pnpm test -- daily-inbox
```
