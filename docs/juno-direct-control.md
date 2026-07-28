# Juno Direct Control

Juno exposes a local, machine-readable control surface for AI agents. It drives the mission compiler,
queue, scheduler, workers, review gate, and verify gate directly; desktop automation is not part of the
execution path.

## Commands

Use `node` when stdout must contain exactly one JSON document:

```powershell
node scripts/juno-control.mjs status
node scripts/juno-control.mjs submit --brief "Add a scoped runtime improvement"
node scripts/juno-control.mjs wait --mission <mission-id> --timeout-ms 1800000
node scripts/juno-control.mjs run --brief "Add a scoped runtime improvement" --timeout-ms 1800000
```

The package alias is available for interactive use:

```powershell
pnpm juno:control -- run --file .\brief.md --timeout-ms 1800000
```

`run` is the primary takeover command. It builds the orchestrator, starts or reuses the single scheduler,
submits the brief, follows phase transitions, and returns only after a terminal outcome.

Progress events are newline-delimited JSON on stderr. The final result is one JSON document on stdout.

## Result Contract

The final snapshot includes:

- `missionStatus`, `phaseDone`, `phaseTotal`, and `currentPhaseId`
- deterministic `gates.review` and `gates.verify`
- `queueDepth`, `backlogDepth`, and `missionQueueDepth`
- `activeRunId`, `activeRunStatus`, and persisted run state
- `schedulerRunning`, `schedulerPid`, `workerRunning`, and `workerPid`
- terminal booleans: `complete`, `blocked`, and `failed`
- retry state: `retryExhausted` (retryable worker failures remain non-terminal)

Exit codes are stable:

| Code | Meaning |
|------|---------|
| `0` | Completed, submitted, or status read succeeded |
| `2` | Mission blocked |
| `3` | Mission failed |
| `4` | Wait timed out |
| `5` | Mission does not exist |
| `64` | Invalid command or arguments |

The control surface is intentionally local. It does not open an unauthenticated HTTP port; Codex and other
local agents call the CLI directly and receive an auditable JSON result.
