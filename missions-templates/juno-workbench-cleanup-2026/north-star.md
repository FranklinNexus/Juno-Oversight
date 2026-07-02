# North Star — juno-workbench-cleanup-2026

**完成定义**：Juno 产生的**临时运行时垃圾**被安全回收，且 **零触碰** 计算机系统、Git 仓库源码、Obsidian Vault、Mission 正文。

## 可删（仅此）

| 路径 | 条件 |
|------|------|
| `AgentWorkbench/runs/<id>/` | 非 `activeRunId`；超过 retention；或空目录 |
| `AgentWorkbench/staging/*` | 超过 14 天未 promote |

## 永不可删

- `missions/`、`config/`、`queue/`、`state/`、`prompts/`、`providers/`、`daily/`、`.cursor/`
- `Juno Oversight` 仓库任意路径
- `Obsidian Vault`、Windows 系统目录、用户文档、桌面其他项目

## 执行方式

**禁止** Agent 手写 `rm -rf` / `Remove-Item -Recurse`。只允许：

```bash
pnpm workbench:purge              # dry-run
pnpm workbench:purge --execute --i-understand
```

## 验收

- `purge-report.json` 存在且 `errors` 为空
- `missions/` 文件数与删前一致（抽查）
- `config/`、`queue/now.yaml` 未被修改（c01/c02 阶段）
