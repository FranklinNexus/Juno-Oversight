# 代码审阅 — 2026-07-05

**范围**：Agent Mind 层（drive / constitution / founder / metacognition / brief / git-promote / mcp）+ 既有 Runtime 栈  
**测试**：141 passing（vitest）  
**审阅结论**：架构方向正确，分层清晰；wiki 此前滞后于代码，本次已对齐 [juno-drive-architecture.md](./juno-drive-architecture.md)。

---

## 1. 做得好的

### 1.1 分层正确

| 层 | 模块 | 评价 |
|----|------|------|
| 战略输入 | constitution + founder-context | 人与 Juno 目标分离，可审计 |
| 张力/好奇 | drive-engine | 可测量 gap，非 prompt 形容词 |
| 元认知 | metacognition + mission-progress 门禁 | **Code decides**，LLM 填表 |
| 执行 | mission-loop + review-loop | 成熟 implement/review/verify 链 |
| 反馈 | evolution-unit fitness | driveScan / initiative 已接入 |

### 1.2 安全边界 intact

- Vault hooks、auto-push 禁 force、mutation denylist charter
- `evaluateCompletedRun` 统一 dequeue 入口，metacognition 挂在此处正确

### 1.3 测试覆盖关键路径

- `drive-engine.test.ts` · `founder-context.test.ts` · `metacognition.test.ts`
- `mission-planner.test.ts` 未因 drive 破坏既有行为（autoQueue 默认 false 对新 mission）

---

## 2. 缺口与风险（按优先级）

### P0 — 应尽快补

| 缺口 | 现状 | 建议 |
|------|------|------|
| **Research mission 空壳** | bootstrap 已有，papers/ 未填 | daemon 跑 dr00–dr04；synthesis 写回 wiki |
| **WisdomEchoes 队头依赖 bootstrap** | autoQueue=false，需手动或 drive proposal | charter 完成 w01–w05 前保持 queue head；drive 已可 proposal |
| **overseer-quality 曾缺 METACOGNITION** | 已补 §2.1 | Live slot 与 wiki 一致 |

### P1 — 下一迭代

| 缺口 | 现状 | 建议 |
|------|------|------|
| **Founder 理解偏浅** | 只读 profile + 笔记标题 | 可选：读 `20_Projects/投资/watch/` 摘要段（仍只读） |
| **serial-boards MCP** | 最小 JSON-RPC stub | hardware mission h02 换 `@modelcontextprotocol/sdk` |
| **Drive 仅 idle 时触发** | queue 有活时不 scan | 可每 N 次 tick 强制 digest（不插队） |
| **planFromDriveEngine 需 constitution** | 无 constitution.json 则 skip | 已文档化；example 复制到 Workbench |

### P2 — 研究驱动

| 缺口 | 建议 |
|------|------|
| 无跨 mission 记忆向量 | agent-drive-research dr09 定方案 |
| 无 GAIA/AgentBench profile | eval-profile 扩展 |
| Revenue metric 无自动验证 | 人工或 Stripe webhook 只读 |

---

## 3. 模块 — 文件对照（真源）

| 能力 | TypeScript | 脚本 | 配置 |
|------|------------|------|------|
| Drive | `drive-engine.ts` | `run-drive-tick.mjs` | `constitution.json` |
| Founder | `founder-context.ts` | — | `founder-alignment.json` |
| Metacognition | `metacognition.ts` | — | `metacognition.json` |
| Brief | `mission-brief.ts` | `juno-brief.mjs` | — |
| Auto-push | `git-promote.ts` | `run-mission-loop.mjs` hook | `auto-push.json` |
| MCP | `mcp-provision.ts` | bootstrap-hardware-mcp | `mcp-servers.json` |
| Planner 集成 | `mission-planner.ts` | `juno-autonomy-tick.mjs` | `autonomy-charter.json` |
| Prompt 注入 | `manifest.ts` | — | `prompts/executor_*.md` |

---

## 4. Wiki 对齐清单

| Wiki | 状态 |
|------|------|
| [juno-drive-architecture.md](./juno-drive-architecture.md) | **新建** — Agent Mind 真源 |
| [juno-architecture.md](./juno-architecture.md) | **更新** — 模块表 + planner 流 |
| [governance.md](./governance.md) | **更新** — METACOGNITION |
| [runtime.md](./runtime.md) | **更新** — drive / brief / push |
| [evolution.md](./evolution.md) | **更新** — fitness v1.1 |
| [overseer-quality.md](./overseer-quality.md) | **更新** — §2.1 METACOGNITION |
| [README.md](./README.md) | **更新** — 六模块索引 |

---

## 5. 建议执行顺序（Juno 自治）

1. `juno-wisdomechoes-axiom-blog-2026` w01–w05（公开面）
2. `juno-agent-drive-research-2026` dr00–dr11（100 篇 → architecture v2）
3. `juno-hardware-mcp-2026`（开发板）
4. dr10 implement 反哺 drive-engine / founder 深读

---

## 6. 审阅签名

| 项 | 值 |
|----|-----|
| 审阅日 | 2026-07-05 |
| Orchestrator 模块数 | 42 `.ts` |
| Agent Mind 新增 | 7 模块 |
| 门禁 | METACOGNITION on review PASS |
