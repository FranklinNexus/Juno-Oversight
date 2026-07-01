---
name: juno-quality-gate
description: >-
  Apply Juno Overseer quality gates and anti-drift review for long-running agent
  missions. Use when reviewing checkpoint, REVIEW_VERDICT, scope-lock, or whether
  an implement slot is ready to proceed.
---

# Juno Quality Gate

## 先读

1. `wiki/overseer-quality.md`
2. `AgentWorkbench/missions/<missionId>/scope-lock.md`
3. `AgentWorkbench/missions/<missionId>/north-star.md`
4. `AgentWorkbench/runs/<runId>/checkpoint.md`（含 REVIEW_VERDICT）
5. `AgentWorkbench/runs/<runId>/events.jsonl`（tail）

## Review 输出

固定六段（中文）：

1. **Verdict 建议** — PASS / REVISE / BLOCK + 理由  
2. **漂移** — none / minor / major；对照 scope-lock  
3. **测试** — test/lint/cargo 状态  
4. **范围** — 本 slot 改动的文件是否在允许列表  
5. **must_fix** — 下一 slot 最多 3 条  
6. **是否可标记 phase done**

## 破坏性操作（§11，致命）

- 检查 events / shell：**禁止** `rmdir /s /q`、`rm -rf`、`Remove-Item -Recurse -Force` 作用于 repo 根或 `Entrepreneurship` 父目录  
- C: 与 D: 的 `Juno Oversight` 可能是**硬链接同一目录** — 「删 D 盘副本」= 删全部  
- 发现尝试或成功执行 → **BLOCK** + 写入 `scope_violations`

## 规则

- Review slot **不允许** 新功能；只允许 verdict + checkpoint  
- major drift → 必须 BLOCK  
- 未跑 verify 就 claim done → REVISE
