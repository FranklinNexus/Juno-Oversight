# 公理之书实验 — juno-axiom-book-2026

**Mission ID**：`juno-axiom-book-2026`  
**作者硬约束**：仅 `missions/juno-axiom-book-2026/charter.md` 四条  
**其余全部 Juno 自主**：公理选择、书名、章节、rubric、review、debate、迭代

---

## 1. Juno 自主决策了什么

| 决策项 | Juno 选择 | 依据 |
|--------|-----------|------|
| 公理 | M1 可错性 + A1–A5 | AGI north-star L0–L8 + 第一性原理 |
| 结构 | 20 章 × ~5000 字 | 十万字 ±5% |
| 书名 | 《从公理生长：智能、世界与 Overseer》 | outline.md |
| 质量标准 | `quality-rubric.md` 第一梯队 rubric | 自设 + charter 质量条 |
| 流程 | decide → debate → 20×(write+review) → merge → verify | workflow `axiom-book` |

决策日志：`missions/juno-axiom-book-2026/decision-log.md`

---

## 2. bounded-autonomy 扩展

AGI 文献 Mission **COMPLETE** 后，Juno **自动**：

1. `queue:axiom-book` — 入队公理之书 Mission  
2. `book:loop` — 推进队列（规划本地 + 章节 Live Agent）

日迭代上限：book 进行中 **24 次/天**（`BOOK_EXPERIMENT_LIMITS`）

---

## 3. 命令

```bash
pnpm queue:axiom-book     # 手动入队
pnpm book:loop            # 单次推进（规划本地；章节由 Codex Live slot 完成）
pnpm book:loop:tick       # autonomy 决策 + 执行
pnpm book:daemon          # 后台每 2min 直接推进 book:loop（不经过总调度 tick）
```

状态：`AgentWorkbench/state/book-loop.json`、`book-quality-loop.json`、`book-daemon.json`、`book-daemon.pid`

`book:daemon` 使用原子 PID 单实例 lease，并在启动时只构建一次 Orchestrator。只有真实 gate dequeue 返回 exit 0；无进展返回 exit 4；明确 BLOCK 或连续 3 次失败返回 exit 5 并写 `terminal_blocked`。它不会在 terminal block 后无限重试；修复 `blockedReason` 后须由操作员显式执行 `corepack pnpm book:daemon -- --unblock-daemon`，普通重启仍保持 BLOCK。

---

## 4. 质量与诚实边界

- **第一梯队**目标需要 **Live Agent** 写章 + 严格 review；本地 loop 只做门禁（字数、结构、公理标注）
- Live slot 依赖本机 Codex 登录；登录失效会记录 provider failure/backoff，不能伪装完成
- 全书 merge 路径：`missions/juno-axiom-book-2026/book/全书.md`
- Mission checkpoint 不是独立完成证据：daemon 还会验证非空的 `axioms.md` / `outline.md` / `quality-rubric.md`、20 章逐章 quality gate 与章节非重复、`book/全书.md` 包含全部章节且至少 95,000 汉字；证据不足的 `STATUS: COMPLETE` 会 terminal block

---

## 5. 与 preliminary AGI 的关系

本书从公理演绎 **Overseer 认识论**，反哺 `juno-agi-north-star.md` L0–L8 缺口；完成后可 promote 到 wiki。
