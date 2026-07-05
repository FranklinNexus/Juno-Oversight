# Evolution — Fitness · Self-optimize · 白名单

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

## Fitness（v1.1 — 2026-07-05）

```
fitness = bookQuality + hardening + capRatio + apiHealth + driveScan(+4) + initiative(+6) - idlePenalty(-3)
```

| 项 | 含义 |
|----|------|
| `driveScanTerm` | autonomy tick 执行 drive scan |
| `initiativeTerm` | drive engine 自 queue mission |
| `idlePenalty` | stop 且未 scan |

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

突变路径：`isMutationPathAllowed` — rubric / registry / mcp-hints 等；**charter 与 Vault hooks 不可自改**。

---

## 命令

```bash
pnpm queue:von-neumann    # bootstrap 元 mission
pnpm evolution:tick       # daemon auto-discover 时默认 script（非 mission:loop）
```
