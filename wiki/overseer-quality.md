# Juno Overseer · 质量与 Review 门禁（权威）

**版本**：0.1  
**目标**：长任务 **不漂移**、**可复盘**、质量 **超过典型 Agent 项目**。

---

## 1. 核心原则

| 原则 | 含义 |
|------|------|
| **Scope Lock** | 每 Mission 有 `scope-lock.md`；slot 内 **禁止** 扩大范围 |
| **Implement ↔ Review 交替** | 写代码 slot 后 **必须** 跟 Review slot；Review **不写新功能** |
| **Checkpoint 是唯一记忆** | 跨 slot 只信 `checkpoint.md` + `scope-lock.md`，不信 Chat 历史 |
| **North Star 每 slot 重读** | `missions/<id>/north-star.md` 定义「什么叫完成」 |
| **可验证** | 每 phase 有 `successCriteria` + 可选 `verify.ps1` |
| **Events 可审计** | 所有输出进 `events.jsonl`；Review 必须引用最近 events |

---

## 2. Review 判决（固定格式）

Review slot 结束时在 `checkpoint.md` 写入：

```markdown
## REVIEW_VERDICT
- verdict: PASS | REVISE | BLOCK
- drift: none | minor | major
- scope_violations: []
- must_fix_next_slot: []
- reviewer_notes: ...
```

| Verdict | 含义 | 下一步 |
|---------|------|--------|
| **PASS** | 本 phase 达标 | Scheduler 进入下一 queue 项 |
| **REVISE** | 有小问题 | 下一 implement slot 只修 must_fix |
| **BLOCK** | 漂移/安全/测试挂 | 停止扩展；先修 BLOCK 项 |

**major drift** → 自动 `BLOCK`；禁止在 REVISE 中「顺便做大重构」。

---

## 2.1 METACOGNITION（2026-07）

**代码**：`orchestrator/src/metacognition.ts` · **配置**：`config/metacognition.json`

Implement / Review / Verify / Drive tick 前，Agent 必须诚实回答（注入于 `manifest.buildUserPrompt`）：

1. 我真正理解 north-star / 创始人目标了吗？
2. Review 够深了吗？有没有偷懒 PASS？
3. 有没有 **具体** 的新 angle 或风险？

Review slot checkpoint **必须**含：

```markdown
## METACOGNITION
- understood: yes|partial|no
- understanding_gaps: []
- reviewed: yes|no
- review_depth: shallow|adequate|deep
- new_angles: ["至少 1 条可行动 alternative"]
- should_revisit: true|false
- confidence: 0.0-1.0
- notes: ...
```

| 规则 | 程序行为 |
|------|----------|
| Review 无 METACOGNITION | `evaluateCompletedRun` → hold |
| `reviewed: no` 或 `new_angles` 不足 | 不得 PASS |
| `understood: no` | 应 REVISE，不得 PASS |

详见 [juno-drive-architecture.md §6](./juno-drive-architecture.md#6-metacognition元认知门禁)。

---

## 3. 三态 Run Kind

| kind | prompt | 允许 |
|------|--------|------|
| `implement` | executor_implement | 改 Juno 仓库 / Workbench 约定路径 |
| `review` | executor_review | 只读代码、写 REVIEW_VERDICT、更新 checkpoint |
| `verify` | executor_verify | 跑 test/lint/cargo；写 verify 报告 |

---

## 4. 防漂移检查清单（Review 必做）

1. `git diff --stat` 是否只在 scope-lock 允许路径内？  
2. 是否新增了 Plan 未列的「顺手」功能？  
3. checkpoint 进度是否与 events.jsonl 一致？  
4. `pnpm test` / `pnpm lint` / `cargo check`（verify phase）  
5. 对照本文件 **§4、§11**：本轮是否引入漂移或 destructive shell？  
6. Promote/Vault：是否误触 Obsidian？（应被 hook 拦截）

---

## 5. 长任务完成定义

Mission `juno-overseer-hardening-2026` 完成当且仅当：

1. 全部 phase `done` + 最终 Review `PASS`  
2. `checkpoint.md` 含 `STATUS: COMPLETE`  
3. `pnpm test` + `pnpm lint` + `cargo check` 绿  
4. `wiki/overseer-quality.md` 与代码行为一致  
5. 至少实现：幂等 spawn、Review 交替 queue、Promote 前可观测

---

## 6. 与 Skills 关系

- **自动 run（SDK）**：只读 `prompts/` + 本文件摘录；**不加载** `.cursor/skills/`  
- **你在 IDE 审**：用 `juno-quality-gate`、`juno-workbench-review`、`review-security`

---

## 7. Slot 契约（prompt 引用）

### 7.1 Implement (`executor_implement`)

- 只改 scope-lock 允许路径；最小 diff  
- 结束必须写 `## CHANGES`  
- **禁止** 递归删除、清库、force push（见 §11）

### 7.2 Review (`executor_review`)

- 只读 + **METACOGNITION** + REVIEW_VERDICT；检查 §4 + **§11 破坏性命令**  
- major drift 或安全违规 → BLOCK
- 无 METACOGNITION → 程序 hold，不出队

### 7.3 Verify (`executor_verify`)

- 只跑验证；失败写 VERIFY_REPORT，不修代码

---

## 8. Checkpoint 结构（跨 slot 契约）

| Section | 写入 slot | 说明 |
|---------|-----------|------|
| `## 目标` | 首个 slot | 本 run / phase 要达成什么 |
| `## 进度` | implement | `- [ ]` / `- [x]` 勾选项 |
| `## CHANGES` | **implement** | 本 slot 改动文件列表 |
| `## REVIEW_VERDICT` | review | §2 固定格式 |
| `## VERIFY_REPORT` | verify | 见 §9 |
| `STATUS: COMPLETE` | 最终 implement / Mission 收尾 | 仅当 Mission 全部 phase done |

### 8.1 progress.md 自动更新（`shouldMarkPhaseDone`）

出队成功后，Scheduler 按 runKind 判定是否将 `progress.md` 对应 phase 标为 `done`：

| runKind | 条件 |
|---------|------|
| implement | checkpoint 含 `STATUS: COMPLETE` |
| review | `REVIEW_VERDICT` → `verdict: PASS` |
| verify | 含 `## VERIFY_REPORT` 且无 FAIL/BLOCK |

实现：`orchestrator/src/mission-progress.ts` → `scheduler-daemon.ts` `handleCompletedRun`。

---

## 9. VERIFY_REPORT 格式

```markdown
## VERIFY_REPORT
- pnpm test: PASS | FAIL
- pnpm lint: PASS | FAIL
- pnpm build: PASS | FAIL
- verify:desktop: PASS | FAIL | SKIP
- cargo check: PASS | FAIL
- orchestrator:build: PASS | FAIL | SKIP
- ui_smoke: PASS | FAIL | SKIP
- notes: ...
```

---

## 10. 隐性 Bug 复查清单

| 项 | 严重度 | 状态 | 说明 |
|----|--------|------|------|
| verify BLOCK 仍 dequeue | 高 | **已修** | `resolveQueueAdvance` + scheduler `handleCompletedRun` |
| `writeOrchestrator("idle", null)` 不清 activeRunId | 高 | **已修** | `mergeOrchestratorState` 显式置空 |
| orchestrator `juno-hud: file:..` | 高 | **已修** | `install-orchestrator.mjs` + preinstall |
| scheduler 未接 review 门禁 | 高 | **已修** | `evaluateCompletedRun` / `shouldSkipSpawn` |
| progress 仅 review PASS 才 done | 中 | **已修** | `shouldMarkPhaseDone` 三态 |
| **Loop gate** | 中 | **已加** | `loop-gate.ts` + `loop_gate_blocked` |
| **硬链接双路径** | **致命** | **文档+hook** | §11；禁止对 C:/D: 任一路径递归删 |
| **无 destructive hook** | **致命** | **已修** | `destructive-ops-gate.mjs` + prompt 注入 |

---

## 11. 破坏性操作防火墙（致命级）

**2026-07-01 事故**：误以为 C: / D: 是两份拷贝，对 D: 执行 `rmdir /s /q`，实际删除唯一硬链接目录。

### 11.1 Agent 永久禁止（除非人类在本 slot 明文授权）

| 类别 | 示例 |
|------|------|
| 递归删除 | `rmdir /s /q`, `rm -rf`, `Remove-Item -Recurse -Force`, `del /s /q` |
| Git 毁灭 | `git clean -fdx`, `git reset --hard`, `git push --force` |
| 保护根 | `Juno Oversight`, `AgentWorkbench`, `Entrepreneurship`, Obsidian Vault |

### 11.2 允许的安全替代

- `pnpm clean`（项目脚本，只清 `out`/`.next`）  
- 单文件 Delete 工具 / 删明确列出的路径  
- 去重前：`fsutil hardlink list <path>` 确认是否同一 inode  

### 11.3 技术防护（必须同时存在）

1. **Prompt 注入**：`buildUserPrompt` 附带 §11 摘录  
2. **Cursor Hook**：`.cursor/hooks/destructive-ops-gate.mjs`（`failClosed: true`）  
3. **Review 必查**：events 里是否出现被拦/执行的 destructive 命令  
4. **Git 备份**：重大 Mission 前 push；Scheduler 不应在无 remote 备份时跑 destructive 任务  

### 11.4 Review 检查项（追加）

- events / shell 是否尝试删 repo 根或父目录？  
- 是否误把「统一路径」当成「删重复拷贝」？  
- 任一 yes → **BLOCK**，Scheduler 不得 dequeue
