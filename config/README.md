# Workbench 配置示例

复制到 `AgentWorkbench/config/`（**不提交** Workbench 内的密钥或本地路径）。

| 文件 | 复制为 | 作用 |
|------|--------|------|
| [api-limits.example.json](./api-limits.example.json) | `api-limits.json` | Cursor/OpenAI RPM、并发、日 token 预算 |
| [self-optimize.example.json](./self-optimize.example.json) | `self-optimize.json` | 自主优化：strict 字数、首选 workflow |
| [mcp-servers.example.json](./mcp-servers.example.json) | `mcp-servers.json` | MCP 注册表；`devOnly` 仅 juno-overseer 任务 |
| [evolution-unit.example.json](./evolution-unit.example.json) | `evolution-unit.json` | **Von Neumann v0** — fitness 权重、突变白名单 |
| [model-defaults.example.json](./model-defaults.example.json) | `model-defaults.json` | Live 模型默认与 fallback 链 |
| [autonomy-charter.example.json](./autonomy-charter.example.json) | `autonomy-charter.json` | **Juno 自主章程** — 不用逐 mission 指派 |
| [daily-schedule.example.json](./daily-schedule.example.json) | `daily-schedule.json` | **每日自动批处理** — 刷满限额 + 隔离导出 + purge |
| [daily-inbox.example.json](./daily-inbox.example.json) | `daily-inbox.json` | **Vault 每日任务** — 写入 `{vault}/Juno/inbox/`（见 `config.yaml` `vault_juno_root`） |
| [wisdomechoes-site.example.json](./wisdomechoes-site.example.json) | `wisdomechoes-site.json` | **WisdomEchoes 本地站** — 仅 `config.yaml` `wisdomechoes_root`，禁止 clone 到其它路径 |

## Vault 隔离（Juno 写入）

Workbench `config.yaml`：

```yaml
vault_path: "E:/Obsidian Vault"
vault_juno_root: "Juno"   # Juno 写 Vault 的唯一根目录
```

- 每日任务 → `Juno/inbox/YYYY-MM-DD-每日任务.md`（次日删）
- 用户偏好 → `Juno/inbox/_profile.md`（常驻）
- **禁止**写 `Juno/` 以外 Vault 路径

## daily-schedule.json

每日 Task Scheduler 调用 `pnpm daily:juno`：

1. 循环 `autonomy:tick --execute` 直到**日限额刷满**（`maxIdleTicks: null` 默认不因 idle 提前停）
2. 复制 Mission 文档 + state 到 **隔离目录**（默认 `E:\JunoDailyExport`，**非 Vault**）
3. 自动 purge `runs/`、`staging/`（保留最近 3 个 run）

```bash
pnpm daily:juno                  # 立即跑一轮
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

Live Composer 默认模型与 fallback 链（默认 `auto` → `composer-2.5` → `composer-2`）。由 `spawn-run.ts` 读取。

## api-limits.json

控制 `orchestrator/src/api-gateway.ts` 对 Live 调用的主动限流。默认 Cursor：`maxRpm: 8`、`maxConcurrent: 1`、`tokenBudgetDaily: 2_500_000`。

```bash
pnpm api:quota
```

## self-optimize.json

`pnpm self:optimize` 读取：

- `strictChapterLength` — 是否硬卡 4500–5500 字/章
- `preferredBookWorkflow` — 覆盖 OPRO 选出的 workflow id
- `autoQueueBookRevise` — scan 失败时是否 bootstrap REVISE 队列

## mcp-servers.json

Live slot prompt 注入 `## MCP (workbench registry)`；`spawn-run` 日志记录 enabled 列表。

- `devOnly: true` — 仅 `repo_target: juno-overseer` 的任务
- `missions: [...]` — 可选 mission 白名单

Obsidian Vault 仍被 `.cursor/hooks` 拦截，与 MCP 配置无关。

## 相关文档

- [runtime.md](../wiki/runtime.md)
- [evolution.md](../wiki/evolution.md)
