# Evolution — Fitness · Canary · 可审计突变

**合并自**：`juno-von-neumann-unit.md` · `juno-self-optimize.md`

元 Mission：`juno-von-neumann-unit-2026`（永不完结 · 度量进化）。

---

## 闭环

```
observe state → plan (charter) → act (spawn) → measure (fitness) → mutate (self-optimize ∩ whitelist)
```

**控制器**：`mission-planner` + `juno:daemon`  
**度量器**：`evolution-unit.ts` → `evolution-fitness.json` · `evolution-log.jsonl`

---

## Fitness（当前 v1）

```
fitness = -10×failedChapters + 5×hardeningDone + 2×capRatio + apiHealth(-20) - 3×idle
```

| 触发 | 行为 |
|------|------|
| 连续 3 日 fitness ↓ | planner → `self:optimize` |
| fitness ↓ + API backoff | `escalate_human` |

**方向（v2）**：Weighted Governance Score — Reliability · Recoverability · Auditability · Human Load · Latency · Token Efficiency

---

## Self-optimize

```bash
pnpm self:optimize      # quality scan → rubric → workflow → MCP hints
pnpm evolution:tick     # 仅写 fitness（无 Live API）
```

突变路径：`isMutationPathAllowed` — rubric / registry / mcp-hints 等；**charter 与 Vault hooks 不可自改**。`self:optimize` 可以创建 workflow proposal，但不会自动 queue 该 canary、promote 或改写 active selection；后续必须走下面的人工 canary。

---

## Workflow canary（manual only）

Canary 比较同一 `evalProfile` 下的 baseline 与 candidate。已知 literature mission 强制使用 `literature` profile；两条 workflow 都必须以 `verify` slot 结束。每次实验为 2-10 个 episode，默认 2。

### CLI 生命周期

```bash
# 1. 列出所有实验，或检查一个已有实验：只读
pnpm evolution:canary
pnpm evolution:canary --id=<experiment-id>

# 2. 创建或复用 proposal；省略 --id 时由输入内容确定性派生 ID
pnpm evolution:canary --baseline=axiom-book --candidate=variants/axiom-book-lean-v2 --target-mission=juno-axiom-book-2026 --source-phase=workflow-canary --episodes=2

# 3. 显式入队。now 为空时进入 now，否则进入 backlog
pnpm evolution:canary --id=<experiment-id> --queue

# 4. runs 完成后收集证据；证据不足时保持 running
pnpm evolution:canary --id=<experiment-id> --evaluate

# 5. 只有 accepted receipt 可以激活 candidate
pnpm evolution:canary --id=<experiment-id> --promote

# 6. 只回滚当前由该 accepted experiment 激活的 selection
pnpm evolution:canary --id=<experiment-id> --rollback
```

不要在命令中插入独立的 `--`；当前 pnpm 会把它原样转给严格参数解析器。源码运行默认先执行 `orchestrator:build`。`--skip-build` 只用于已经完成完整性检查的 desktop runtime，或操作员刚刚显式构建过的同一源码树，不应成为日常捷径。

Proposal 定义本身会创建不可覆盖的 proposal 文件，因此不是纯读操作；但它不会创建 running record、fixture、queue item、decision 或 selection。对已有 ID 不带 action flag 时仅 inspect。`--queue`、`--evaluate`、`--promote`、`--rollback` 一次只能指定一个；所有 queue、decision 与 active-selection 突变都需要对应的显式 flag。

### 判定策略

只有满足以下条件才会写 `accepted` decision receipt：

- baseline 与 candidate 都完成全部 episode，且每个 episode 都有 deterministic verify PASS；
- candidate 没有 safety block；
- candidate 的 verify pass rate、failure rate、revise rate、retry cost 和 slot cost 均不退化；
- 上述指标至少有一项严格改善。完全持平会被拒绝。

`evaluate` 在证据不足时只返回 `running`；terminal 时才用 create-once 写入 accepted/rejected receipt。`promote` 会再次核对 workflow、prompt、fixture 与 live evidence，然后以 selection lease 和 compare-and-swap 安装 trusted v1 selection。`rollback` 只接受该 experiment 当前激活的 trusted selection；之前没有 selection 时删除当前 selection，之前有 selection 时仅恢复仍然可信的精确 preimage。

### Literature micro fixture v2

`juno-axiom-book-2026` 不用生产环境的 20 章书做 canary。每个 arm/episode 都获得独立 sample mission，fixture v2 包含：

- `brief.md`：固定的 `[S1]`、`[S2]`、`[S3]` source capsules；
- `rubric.md`：450-900 English words、Thesis / Argument / Counterargument / Conclusion、三条引用、auditable + falsifiable + oversight thesis，以及反驳与证据约束；
- `essay.md`：唯一允许修改的 artifact，seed 故意不满足门禁，但存在可达 PASS 文本；
- `north-star.md`、`progress.md`、`scope-lock.md`：只读控制文件。

统一 prompt 为 `workflow_canary_literature_v1`，根据 `runKind` 约束 implement、review/debate/vote 与 verify。Validator 沿用目标 mission 的 literature 规则身份，但 artifact root 固定为隔离 sample；不会读取生产 mission 产物。确定性检查验证只读 fixture 精确字节、`essay.md` 是 exclusive regular file、字数、四个 section、三条引用、auditable/falsifiable/oversight thesis，并确认 seed 已被替换。

### 端到端信任链

| 层 | 绑定内容 | 漂移时行为 |
|----|----------|------------|
| Proposal | target/source/episodes、previous selection、baseline/candidate workflow definition SHA-256、`promptSha256ByTemplate`、fixture template SHA-256 | 同 ID 不同内容拒绝；后续 inspect/queue/evaluate/promote fail closed |
| Compiled slot | proposal experiment/arm/episode、workflow/profile、mission/phase/runKind、fixture SHA、每个 template 的 prompt SHA | queue 六字段不完整、slot fingerprint 冲突或 workflow compile 不一致即拒绝 |
| Fixture receipt | experiment/arm/episode/sample mission、fixture version/template SHA、rendered files SHA | create-once；receipt schema/hash 或 sample 目录不一致即 verify FAIL |
| Prompt bytes | proposal 同时绑定 canary prompt 与 baseline/candidate 实际 production templates | descriptor 限读 256 KiB；symlink/hardlink、非 UTF-8、读取中变化或 SHA 漂移均拒绝 |
| Manifest/runtime | queue 字段原样进入 `experimentPromptSha256`、`experimentFixtureSha256` 等 manifest 字段 | materialize 与 `buildUserPrompt` 都重新读取 exact prompt bytes；不匹配不启动 run |
| Execution evidence | 重新编译 expected slot；精确核对 materialized `queue-item.json` 与 manifest；Codex/verify artifact v2 绑定 checkpoint、完整 events、attempt/slot/retry；verify step 与预期 profile command 及 started/completed event 逐项对应 | 旧三文件伪造、任意命令替换、缺/错序 events、跨 run artifact、少报 retry、断裂 REVISE lineage均拒绝 |
| Decision/selection | decision receipt 绑定 proposal SHA、fixture SHA、metrics、完整 evidence 与 evidence SHA；active selection 再绑定 decision receipt SHA | receipt/live evidence 不一致不能 promote；未知 writer、selection lease/preimage 异常时 fail closed |

REVISE fix 也不能绕过链路：`revision_of` 必须指向实际给出 REVISE 的 compiled review/debate/vote slot，`revision_attempt` 必须连续且 ID 可确定性推导，mission/arm/episode/workflow/profile/source/fixture/prompt 绑定必须保持一致。

---

## Legacy workflow selection migration

旧版 selection 不会被 canary 静默吞掉。先执行只读 inspect：

```bash
pnpm workflow:selection:migrate
```

输出状态只有 `missing`、`legacy_v0`、`trusted_v1`、`unsupported`。只有 `legacy_v0` 可以 commit；它必须恰好由 `workflowId`、`score`、`reasons`、`updatedAt` 四个字段组成。`trusted_v1` 必须使用对应 canary 的 rollback；malformed、伪造 v1、未知 schema 一律视为 `unsupported`。

确认 inspect 输出的 SHA-256 后，显式提交：

```bash
pnpm workflow:selection:migrate --commit --expected-sha256=<64-hex-from-inspect> --reason="Archive obsolete legacy v0 selection"
```

Commit 要求 reason 已 trim、非空、最多 500 字符，并拒绝控制字符。迁移只接受不超过 64 KiB 的 exclusive regular source；symlink、hardlink、内容/metadata 竞态均拒绝。执行前 selection lease 必须可获取，所有 daemon、autonomy lock、run launcher、active orchestrator run 与未决 workflow experiment 必须静默。

归档使用 `state/workflow-selection-archive/<selection-sha256>.json` 保存原始字节，并以 create-once receipt 绑定 source path、archive path、SHA、byte length、legacy schema/workflow、operator reason 与时间。既有 archive/receipt 不会覆盖；中断后可基于完全一致的 archive 收敛恢复；receipt 提交后 selection 被重建时会拒绝继续，迁移不会改动 queue。

---

## 命令

```bash
pnpm queue:von-neumann    # bootstrap 元 mission
pnpm evolution:tick       # daemon auto-discover 时默认 script（非 mission:loop）
pnpm evolution:canary     # 只读列出 workflow experiments
pnpm workflow:selection:migrate  # 只读检查 legacy selection
```
