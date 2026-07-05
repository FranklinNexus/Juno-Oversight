# Governance — 机器可读 Review · Scope · Promote · Metacognition

**合并自**：`overseer-quality.md`（摘要）· `mission-patterns.md`（索引）

**权威全文** → [overseer-quality.md](./overseer-quality.md)  
**Agent Mind** → [juno-drive-architecture.md §6](./juno-drive-architecture.md#6-metacognition元认知门禁)

---

## 原则

| 原则 | 含义 |
|------|------|
| Scope Lock | 每 Mission `scope-lock.md`；禁止扩大范围 |
| Checkpoint 唯一记忆 | 跨 Run 只信 checkpoint + scope-lock |
| Implement ↔ Review 交替 | Review 不写新功能 |
| 确定性门禁 | **LLM proposes · Code decides** |
| **Metacognition** | Review 必须自问 + 写 `METACOGNITION`（见下） |

---

## METACOGNITION（2026-07）

每个 Live slot prompt 注入 [元认知自问](./juno-drive-architecture.md#6-metacognition元认知门禁)。Review **硬门禁**：

```markdown
## METACOGNITION
- understood: yes|partial|no
- understanding_gaps: []
- reviewed: yes|no
- new_angles: ["具体 alternative，≥1 条"]
- confidence: 0.0-1.0
- notes: 想明白了吗？review 了吗？
```

无 METACOGNITION → `evaluateCompletedRun` **hold**，不出队。

---

## REVIEW_VERDICT

```markdown
## REVIEW_VERDICT
- verdict: PASS | REVISE | BLOCK
- drift: none | minor | major
- scope_violations: []
- must_fix_next_slot: []
```

| Verdict | 队列 |
|---------|------|
| PASS | 出队 |
| REVISE | 插入 fix implement |
| BLOCK | 停止，等人 |

---

## Run kind 过关条件

| kind | 过关 |
|------|------|
| implement | `STATUS: COMPLETE` + `## CHANGES` |
| review | `METACOGNITION` + `REVIEW_VERDICT` PASS + `new_angles≥1` |
| verify | `## VERIFY_REPORT`，无 FAIL |

---

## Promote

1. Agent → `staging/`
2. HUD **Promote 预览**（diff）
3. 人确认 → Vault（`promote.require_human: true`）

---

## Mission 模式库

完成 Mission 的模式可 promote 到 [mission-patterns.md](./mission-patterns.md)（`pnpm` promote-mission-wiki 脚本）。
