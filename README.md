<p align="center">
  <img src="docs/assets/juno-overseer-banner.png" alt="Juno" width="720" />
</p>

<h1 align="center">Juno</h1>

<p align="center">
  <strong>AI Work Runtime</strong> — long-running agent work with checkpoints, review gates, and bounded autonomy<br/>
  <em>Models generate. Gates decide.</em>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Node-%3E%3D22.13-339933?logo=node.js&logoColor=white" alt="Node" />
  <img src="https://img.shields.io/badge/tests-127_passing-success" alt="tests" />
  <img src="https://img.shields.io/badge/Tauri-2-24C8DB?logo=tauri&logoColor=white" alt="Tauri" />
</p>

---

## Turn Cursor into an overnight worker

**Juno makes AI work resumable.**

Most tools stop at *Agent finished → Done.*

Juno stops at *Agent finished → **Review** → **Verify** → **Human promote** → Vault.*

```text
Chat          Chat          Chat          Chat     →  context dies, no audit

implement  →  review  →  verify  →  promote     →  checkpoint memory, gates decide
```

Run a **Mission** overnight. Wake up to a queue that either moved forward — or **blocked** with a machine-readable reason.

<p align="center">
  <img src="docs/assets/juno-flow-diagram.png" alt="Mission → spawn → checkpoint → review → verify → promote" width="720" />
  <br/>
  <sub>Mission queue · Live spawn · checkpoint · REVIEW_VERDICT · Promote preview · Vault</sub>
</p>

> **Demo GIF** — [`docs/assets/`](docs/assets/) (add `juno-demo.gif` here). Until then, run `pnpm loop:smoke` locally for a 2-minute end-to-end pass.

```bash
git clone https://github.com/FranklinNexus/Juno-Oversight.git && cd Juno-Oversight
pnpm install && pnpm loop:smoke    # no API key · implement → review → verify
```

---

## Why

| Without Juno | With Juno |
|--------------|-----------|
| Context lost between sessions | **Checkpoint** is the only memory across runs |
| “Looks done” with no proof | **Deterministic gates** — code decides dequeue, not the model |
| Agents edit anything | **Scope lock** per mission |
| 24/7 = unbounded spend & risk | **Bounded autonomy** — daily cap, API backoff, escalate to human |
| Vault / repo accidents | **Hooks** block Vault writes & destructive shell/git |

**Juno is not another agent framework.** It is a **workflow runtime**: queue, spawn, gate, replay, promote.

---

## The sell: machine governance (Oversight)

Every serious engineering team uses **Pull Requests**. Long-running AI work needs the same — but machine-readable.

After each run, the **Review gate** emits a verdict:

```markdown
## REVIEW_VERDICT
- verdict: PASS | REVISE | BLOCK
- drift: none | minor | major
- scope_violations: []
- must_fix_next_slot: []
```

| Verdict | What happens |
|---------|----------------|
| **PASS** | Queue advances |
| **REVISE** | Fix run queued with `must_fix` |
| **BLOCK** | **Stops.** No silent drift. Human decides. |

**Implement** requires `STATUS: COMPLETE` + `## CHANGES`. **Verify** requires `## VERIFY_REPORT`. Empty checkpoint → **hold**.

> **LLM proposes. Code decides.**

Most stacks (AutoGen, CrewAI, OpenHands, LangGraph, …) end at *task complete*. Juno adds **audit · replay · resume · promote** — closer to **GitHub PR + CI** than to another chat loop.

---

## What you can run

| Workload | What Juno gives you |
|----------|---------------------|
| Overnight writing / synthesis | Mission queue, quality gates, cap limits |
| Large research batches | Checkpoint resume, scoped paths |
| Orchestrator / repo hardening | implement → review → verify pipeline (126 tests) |
| Staging → knowledge base | **Promote preview** → human confirm → Vault |

One **`pnpm juno:daemon`** loop: charter in, gated work out — no hand-assigning every mission.

---

## Architecture

Not “HUD → Orchestrator → folder.” **Governance first:**

```text
                    Constitution
                   (charter · hooks)
                          │
                   Mission Planner
                          │
         ┌────────────────┴────────────────┐
         │                                 │
    Implement                         Review
         │                                 │
         └────────────────┬────────────────┘
                          │
                       Verify
                          │
                  Human Promote
                          │
                       Vault
```

**Three layers (only three):**

| Layer | Role |
|-------|------|
| **Runtime** | Queue · spawn · gates · daemon (`orchestrator/` + `scripts/`) |
| **Surface** | HUD — queue, active run, promote preview (`src/` + Tauri) |
| **State** | Local work dir — missions, checkpoints, audit log (`AgentWorkbench/`, not in git) |

Environment: `AGENT_WORKBENCH_ROOT` · `JUNO_OVERSIGHT_ROOT` · `CURSOR_API_KEY` (Live runs).

---

## Quick start

```bash
pnpm install && pnpm test
cp .env.example .env.local
.\scripts\scaffold-workbench.ps1          # Windows; see wiki/modules/runtime.md
node scripts/sync-workbench-hooks.mjs
pnpm orchestrator:build && pnpm verify:desktop
pnpm tauri:dev                            # Surface
pnpm juno:daemon                          # Runtime loop
pnpm autonomy:tick                        # Preview next mission (dry-run)
```

| You want… | Command |
|-----------|---------|
| Zero-API smoke test | `pnpm loop:smoke` |
| Run queue head (Live) | `pnpm mission:loop` |
| Safe cleanup | `pnpm workbench:purge` |
| Full desktop gate | `pnpm verify:desktop` |

Config templates → [config/README.md](./config/README.md). Troubleshooting → [wiki/maintenance.md](./wiki/maintenance.md).

---

## Eight words

Everything else is implementation detail.

| Term | Meaning |
|------|---------|
| **Mission** | A bounded goal (north-star + scope-lock + phases) |
| **Queue** | Ordered work in `now.yaml` |
| **Run** | One Live or local agent execution |
| **Checkpoint** | Durable memory for a run / mission |
| **Gate** | Deterministic pass/fail (review · verify · complete) |
| **Charter** | Your rules — what Juno may do autonomously |
| **Promote** | Human-approved copy into Vault |
| **Runtime** | Juno itself — not the LLM |

---

## Theory & philosophy

<details>
<summary><strong>For readers who want the “why it’s built this way” story</strong></summary>

### Deterministic governance

Intelligence is probabilistic. **Governance is deterministic.** Juno separates *generation* (Cursor / MCP) from *permission to proceed* (TypeScript gates, hooks, caps).

### Bounded autonomy (not “AGI”)

Juno does **not** promise open-ended self-evolution. It ships **bounded autonomy**: daily iteration cap, mission whitelist, API backoff, `escalate_human` when fitness drops under load. That is engineering, not a manifesto.

### Von Neumann unit (v0–v1)

Open-system framing: charter + registry = genotype (human-owned); spawn + loops = constructor; git + export + evolution-log = replicator; planner + daemon = controller.

```
observe → plan → act → measure → mutate (∩ whitelist)
```

Current fitness (project KPIs today):

```
fitness = -10×failedChapters + 5×hardeningDone + 2×capRatio + apiHealth(-20) - 3×idle
```

**Direction:** evolve toward a **Weighted Governance Score** — Reliability · Recoverability · Auditability · Human Load · Latency · Token Efficiency — so the same runtime serves coding, research, trading, analysis without rewrites.

### Negative entropy · scalable oversight

Workbench holds ephemeral runs/staging; Vault stays read-only. Agent proposes next mission; human keeps **charter** and **promote**. Amodei-style oversight without unbounded AutoGPT loops.

Deep dives → [modules/evolution.md](./wiki/modules/evolution.md) · [overseer-quality.md](./wiki/overseer-quality.md)

</details>

---

## Docs

| When you need… | Link |
|----------------|------|
| Module map & state files | [wiki/modules/runtime.md](./wiki/modules/runtime.md) · [juno-architecture.md](./wiki/juno-architecture.md) |
| Gate spec (authoritative) | [overseer-quality.md](./wiki/overseer-quality.md) |
| Full wiki index | [wiki/modules/README.md](./wiki/modules/README.md) |
| Full index | [wiki/README.md](./wiki/README.md) |

---

## License

MIT-style — [FranklinNexus/Juno-Oversight](https://github.com/FranklinNexus/Juno-Oversight). Source of truth: `orchestrator/src/` + wiki when aligned.

<p align="center">
  <img src="docs/assets/juno-architecture-loop.png" alt="" width="48" />
  <br/>
  <sub><strong>Juno</strong> — AI Work Runtime · Models generate. Gates decide.</sub>
</p>
