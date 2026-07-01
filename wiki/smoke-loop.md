# Smoke Loop — 最小 Overseer 试跑

Mission **`juno-smoke-loop-2026`** 用约 **75 分钟 / 3 slot** 验证 implement → review → verify 全链路。

---

## 1. 目标

| 要证明 | 说明 |
|--------|------|
| Implement | scope 内交付小脚本 |
| Review | 写 REVIEW_VERDICT，不改功能 |
| Verify | test + orchestrator 门禁 + UI 冒烟 |

---

## 2. 三 Slot

| phase_id | kind | success_criteria |
|----------|------|------------------|
| `sl00-implement-ui-smoke` | implement | `scripts/ui-smoke.mjs` + `pnpm ui:smoke`；checkpoint 含 CHANGES |
| `sl01-review-ui-smoke` | review | REVIEW_VERDICT PASS on ui-smoke |
| `sl02-verify-smoke` | verify | VERIFY_REPORT：test、check-orchestrator-deps、ui:smoke PASS 或 documented SKIP |

队列 id：`juno-sl00-implement-ui-smoke` → `juno-sl01-review-ui-smoke` → `juno-sl02-verify-smoke`。

---

## 3. 交付物（Juno 仓库）

| 路径 | 说明 |
|------|------|
| `scripts/ui-smoke.mjs` | GET dev 根路径；拒绝已知 Next 错误字符串 |
| `package.json` → `"ui:smoke"` | npm script |
| `wiki/smoke-loop.md` | 本说明 |

Scope 见 Workbench `missions/juno-smoke-loop-2026/scope-lock.md`。

---

## 4. 命令

### 4.1 一次性 Bootstrap

```powershell
cd "C:\Users\kfr34\Desktop\Entrepreneurship\Juno Oversight"
.\scripts\bootstrap-smoke-loop.ps1    # scheduler 默认 enabled: false
pnpm orchestrator:build
```

或：`.\scripts\start-smoke-loop.ps1 [-StartDaemon]`

### 4.2 一键跑通（推荐）

```powershell
pnpm loop:smoke    # bootstrap + 真实 verify + 出队 + progress.md
```

### 4.3 Dry 模拟（不调用 Cursor API）

```powershell
$env:AGENT_WORKBENCH_ROOT="E:\AgentWorkbench"
node scripts/simulate-smoke-loop.mjs
```

预期：三 slot 均 `dequeue`，模拟队列清空。

### 4.3 Verify slot 前置

```powershell
pnpm dev --port 3000    # 终端 A
pnpm ui:smoke           # 终端 B → [ui-smoke] PASS
pnpm test               # 54/54
```

### 4.4 LIVE Loop（需 API Key）

```powershell
pnpm dev --port 3000
# 编辑 E:\AgentWorkbench\state\scheduler.json → "enabled": true
node orchestrator/dist/scheduler-daemon.js
# 或 WIDGET-S Start Daemon
```

---

## 5. ui-smoke 行为

```bash
pnpm dev
pnpm ui:smoke
# JUNO_DEV_URL=http://127.0.0.1:3000 pnpm ui:smoke
```

检查：

- HTTP **200**
- body **不含**：`Internal Server Error`、`Turbopack error`、`Runtime Error`

dev server 未启动 → FAIL（连接拒绝），verify slot 应写在 VERIFY_REPORT 中。

---

## 6. Checkpoint 模板

**sl00 implement**

```markdown
STATUS: COMPLETE

## CHANGES
- scripts/ui-smoke.mjs
- package.json ui:smoke
```

**sl01 review**

```markdown
## REVIEW_VERDICT
- verdict: PASS
- drift: none
- scope_violations: []
- must_fix_next_slot: []
```

**sl02 verify**

```markdown
## VERIFY_REPORT
- pnpm test: PASS
- check-orchestrator-deps: PASS
- ui_smoke: PASS
```

---

## 7. 相关文档

- 门禁逻辑：[overseer-quality.md §2–§9](./overseer-quality.md)
- Scheduler：[orchestrator.md](./orchestrator.md)
- Workbench Mission 文件：[workbench.md §3](./workbench.md#3-mission-生命周期)
