# Getting Started

This guide takes a new Windows machine from a clone to a real governed Juno mission.

## Prerequisites

- Windows 10 or 11
- Git
- Node.js 22.13 or newer
- pnpm 10
- Rust stable for Tauri and the full desktop verification gate
- A Cursor API key for Live missions

## 1. Install and initialize

```powershell
git clone https://github.com/FranklinNexus/Juno-Oversight.git
cd Juno-Oversight
pnpm install
pnpm juno:setup
```

By default, setup uses `%USERPROFILE%\JunoWorkbench`. Select another external directory with:

```powershell
pnpm juno:setup -- --workbench D:\JunoWorkbench
```

Setup is idempotent. Existing queue, state, config, and API keys are preserved. It creates or refreshes:

- `.env.local` with the repository and workbench paths;
- the empty queue and idle scheduler/orchestrator state;
- conservative API, model, MCP, and metacognition defaults;
- Cursor safety hooks in the workbench.

The workbench must be outside the Git repository.

## 2. Diagnose the machine

```powershell
pnpm juno:doctor
```

The JSON result separates `readyForSmoke` from `readyForLive`. Warnings do not hide failures and every
failed check includes a corrective command.

## 3. Prove the runtime without a model

```powershell
pnpm loop:smoke
```

This builds the orchestrator and exercises queue materialization, checkpoints, review/verify decisions,
dequeue, progress synchronization, and the loop gate without consuming API quota. The smoke workbench is
temporary and isolated from the configured Live queue and scheduler.

## 4. Enable Live missions

Open `.env.local` and set:

```dotenv
CURSOR_API_KEY=your-key
```

Do not commit this file. Confirm readiness:

```powershell
pnpm juno:doctor -- --live
```

## 5. Run a real task

```powershell
node scripts/juno-control.mjs run `
  --brief "Add docs/example.md with a verified operational example; do not commit or push" `
  --timeout-ms 1800000
```

Use `node scripts/juno-control.mjs` when another program needs exactly one final JSON document on stdout.
Progress events go to stderr.

## 6. Start at logon

```powershell
pnpm juno:autonomy:install
```

The installer prefers Windows Task Scheduler and falls back to a per-user Startup shortcut when elevated
task registration is unavailable. Both paths call the same single-instance scheduler.

## Common failures

| Symptom | Check | Resolution |
|---------|-------|------------|
| `CURSOR_API_KEY` missing | `pnpm juno:doctor -- --live` | Add the key to `.env.local` |
| Wrong workbench is used | Inspect `workbench` in doctor JSON | Rerun setup with `--workbench` |
| Scheduler PID exists but is dead | `juno-control status` reports `schedulerRunning=false` | Run `pnpm juno:daemon` |
| Mission stops at review | Read `runs/<review-id>/checkpoint.md` | Apply `must_fix_next_slot` or resolve BLOCK |
| Mission times out | Inspect worker PID, heartbeat, and events | Fix the provider issue, then resubmit or wait |
| Next/Turbopack runtime error | `pnpm verify:desktop` | Resolve the first failing gate before restarting |

More runtime detail is available in [wiki/runtime.md](../wiki/runtime.md) and
[docs/juno-direct-control.md](./juno-direct-control.md).
