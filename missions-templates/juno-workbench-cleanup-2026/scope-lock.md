# Scope Lock — juno-workbench-cleanup-2026

## 允许修改

- `orchestrator/src/workbench-purge.ts`（purge 引擎）
- `scripts/run-workbench-purge.mjs`
- `missions/juno-workbench-cleanup-2026/**`（报告、progress、checkpoint）

## 允许执行（仅此 CLI）

```bash
pnpm workbench:purge
pnpm workbench:purge --execute --i-understand
```

## 禁止

- **任何** shell 递归删除（`rm -rf`、`rmdir /s`、`Remove-Item -Recurse`）
- 修改 `missions/` 下**其他** mission 的文件
- 修改 `config/`、`queue/`、`state/`（**只读** `state/orchestrator.json` 取 activeRunId）
- 触碰 `Juno Oversight` 源码树（本 mission 的 implement 仅限 purge 脚本本身）
- Obsidian Vault、Entrepreneurship 其他目录、Windows 系统路径
- `git clean`、`git reset --hard`、force push

## 安全契约

Purge 引擎 `isSafePurgePath()` 必须在每次删除前通过；违规则 REVIEW_VERDICT **BLOCK**。
