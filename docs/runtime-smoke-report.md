# Runtime Smoke Report

- generatedAt: 2026-07-28T00:31:01+08:00
- generatedAtUtc: 2026-07-27T16:31:01Z
- branch: `codex/result-driven-kpi`
- commit: `a197b72` (`a197b7223c941d4db8d983edbb7a7caee31e6a9f`)
- repo: `C:\Users\kfr34\Desktop\Entrepreneurship\Active\Juno-Oversight`
- workbench: `E:\AgentWorkbench`
- **verdict: PASS**

## Branch

- command: `git branch --show-current` + `git rev-parse --short HEAD`
- branch: `codex/result-driven-kpi`
- commitShort: `a197b72`
- commitFull: `a197b7223c941d4db8d983edbb7a7caee31e6a9f`
- notes: recorded only; dirty working tree / uncommitted WIP not part of PASS/FAIL criteria

## Full test status

- command: `pnpm test`
- result: **PASS**
- exitCode: 0
- summary: Test Files 45 passed (45); Tests 169 passed (169)
- duration: ~18.3s (vitest 3.2.6)
- notes: stderr noise from zustand persist in `mock-feed-connection.test.ts` only; no failures

## Live Key probe

- command: `pnpm orchestrator:test:live` (`scripts/test-live-key.mjs`)
- result: **PASS**
- exitCode: 0
- status: `finished`
- resultBody: `JUNO_LIVE_OK`
- notes: API key not written here; Node v22.13.1 OK

## Scheduler PID & heartbeat

- pidFile: `E:\AgentWorkbench\state\daemon.pid`
- pid: `55412`
- processAlive: true
- processName: `node`
- processStartLocal: `2026-07-28T00:20:34.8792065+08:00`
- scheduler.enabled: true
- daemonStartedAt: `2026-07-27T16:20:34.979Z`
- lastTickAt: `2026-07-27T16:31:00.051Z` (fresh vs probe time; tick age ≪ 2 min)
- lastAction: `spawn`
- lastRunId: `juno-brief-20260727-在-juno-oversight-仓库创建-docs-r-p02-implement`
- runHeartbeat: `E:\AgentWorkbench\runs\juno-brief-20260727-在-juno-oversight-仓库创建-docs-r-p02-implement\heartbeat.json` → `{"ts":"2026-07-27T16:31:00.690Z"}`
- result: **PASS**

## Verdict rationale

| Check | Result |
|-------|--------|
| Full test (`pnpm test`) | PASS |
| Live Key (`pnpm orchestrator:test:live`) | PASS |
| Scheduler PID alive (`daemon.pid` → 55412) | PASS |
| Scheduler heartbeat (`enabled` + fresh `lastTickAt`) | PASS |

All four primary criteria PASS → **overall verdict: PASS**.

No version-control publish actions were performed (no `git add` / `commit` / `push`).
