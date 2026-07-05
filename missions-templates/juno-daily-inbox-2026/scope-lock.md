# Scope Lock — juno-daily-inbox-2026

## 允许修改

- `orchestrator/src/daily-inbox.ts`（新建）
- `orchestrator/src/daily-schedule.ts`（可选）
- `src/lib/workbench/daily-inbox.test.ts`（新建）
- `scripts/run-daily-inbox.mjs`（新建）
- `scripts/run-daily-juno.mjs`（开头 hook）
- `scripts/bootstrap-daily-inbox.mjs`
- `config/daily-inbox.example.json`
- `package.json`（`daily:inbox` script）
- `missions-templates/juno-daily-inbox-2026/**`
- **`E:/Obsidian Vault/Juno/**` only**（`README.md`、`inbox/_profile.md`、`inbox/YYYY-MM-DD-每日任务.md`）

## 禁止

- 写 Vault **`Juno/` 以外**任何路径
- 改 `daily-export.ts` 的隔离导出逻辑
- force-push / 删 Vault 其他目录
- 破坏性 shell（§11）

## Vault 读范围（i03 定制节）

- `Juno/inbox/_profile.md`（用户偏好，常驻）
- `20_Projects/**` 最近 7 天修改的 `.md`（只读摘要）
- deny：`学校/**`、`发票/**`、`.obsidian/**`、`Juno/**`（避免自引用循环）
