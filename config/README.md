# Workbench 配置示例

复制到 `AgentWorkbench/config/`（**不提交** Workbench 内的密钥或本地路径）。

| 文件 | 复制为 | 作用 |
|------|--------|------|
| [api-limits.example.json](./api-limits.example.json) | `api-limits.json` | Codex RPM、lease 并发、日 token 预算 |
| [self-optimize.example.json](./self-optimize.example.json) | `self-optimize.json` | 自主优化：strict 字数、首选 workflow |
| [mcp-servers.example.json](./mcp-servers.example.json) | `mcp-servers.json` | MCP 注册表；`devOnly` 仅 juno-overseer 任务 |
| [evolution-unit.example.json](./evolution-unit.example.json) | `evolution-unit.json` | **Von Neumann v0** — fitness 权重、突变白名单 |
| [model-defaults.example.json](./model-defaults.example.json) | `model-defaults.json` | 默认 provider 与旧队列迁移映射 |
| [autonomy-charter.example.json](./autonomy-charter.example.json) | `autonomy-charter.json` | **Juno 自主章程** — 不用逐 mission 指派 |
| [daily-schedule.example.json](./daily-schedule.example.json) | `daily-schedule.json` | **每日自动批处理** — 刷满限额 + 隔离导出 + purge |

## daily-schedule.json

每日 Task Scheduler 调用 `pnpm daily:juno`：

1. 循环 `autonomy:tick --execute`，直到日限额刷满或连续 5 次无进展；连续失败也有独立上限，未填 cap 时记录 `blocked`
2. 复制 Mission 文档 + state 到 **隔离目录**（默认 `E:\JunoDailyExport`，**非 Vault**）
3. 自动 purge `runs/`、`staging/`（保留最近 3 个 run）

```bash
pnpm daily:juno                  # 立即跑一轮
pnpm daily:juno -- --unblock-daily # 修复原因后显式解除同日 blocked/failed 终态
pnpm daily:juno:install          # Windows 计划任务（默认 0:00）
pnpm daily:juno:uninstall
```

`exportRoot` 不得与 Vault、Workbench、Juno 仓库路径重叠。

## workbench:purge（安全清理）

仅删除 `runs/`、`staging/` 下过期临时产物；**永不**触碰 missions、config、queue、state、仓库或 Vault：

```bash
pnpm workbench:purge
pnpm workbench:purge --execute --i-understand
pnpm queue:cleanup              # bootstrap cleanup mission（默认不覆盖 busy queue）
```

见 `missions-templates/juno-workbench-cleanup-2026/`。

## autonomy-charter.json

Juno 根据章程 + mission registry **自己选下一 mission**：

```bash
pnpm autonomy:tick              # 预览决策
pnpm autonomy:tick --execute  # 执行
pnpm juno:daemon                # 后台循环（推荐）
```

见 [runtime.md](../wiki/runtime.md) · [juno-architecture.md](../wiki/juno-architecture.md) §2。

## evolution-unit.json

Von Neumann 自指单元 — fitness 权重、`plannerFeedback`（7d MA、连续下降 → self-optimize）：

```bash
pnpm evolution:tick
pnpm queue:von-neumann
```

见 [evolution.md](../wiki/evolution.md)。

## model-defaults.json

默认执行器为 `openai_codex`。`cursor_composer` 只用于读取旧 queue/manifest，并被 canonicalize 到 Codex；旧 Composer model id 不会传给 Codex。

## api-limits.json

控制 `orchestrator/src/api-gateway.ts` 对 Codex Live slot 的主动限流。并发使用带 PID/expiry 的 lease；SDK 完成事件返回的 usage 会校正 token 预估。

```bash
pnpm api:quota
```

## self-optimize.json

`pnpm self:optimize` 读取：

- `strictChapterLength` — 是否硬卡 4500–5500 字/章
- `preferredBookWorkflow` — 覆盖 OPRO 选出的 workflow id
- `autoQueueBookRevise` — scan 失败时是否 bootstrap REVISE 队列；默认 `true`，本次解析结果随 report 写入 `state/self-optimize.json`，入口不会再次读取配置

## mcp-servers.json

Live slot prompt 注入 `## MCP (workbench registry)` capability hint。它不等于 server 已挂载；Agent 只能使用当前 Codex 会话真实暴露的工具。

- `devOnly: true` — 仅 `repo_target: juno-overseer` 的任务
- `missions: [...]` — 可选 mission 白名单

Codex slot 的主边界是 SDK sandbox、scope-lock/baseline verify 与 Promote containment。`.cursor/hooks` 只保护人工 Cursor 会话，属于额外防护。

## 相关文档

- [runtime.md](../wiki/runtime.md)
- [evolution.md](../wiki/evolution.md)
