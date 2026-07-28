# Juno-Oversight 产品发布就绪审计（非视觉）

- generatedAtLocal: `2026-07-29T02:37:29+08:00`
- generatedAtUtc: `2026-07-28T18:37:29Z`
- branch: `codex/result-driven-kpi`
- commit: `d6aaf8c` (`d6aaf8c5f0cbc8c518a1f1050896f4066d20aaf2`)
- repo: `C:\Users\kfr34\Desktop\Entrepreneurship\Active\Juno-Oversight`
- workbench: `E:\AgentWorkbench`
- auditor: local agent on the developer machine (warm checkout; not a cold clone)
- scope: **only** this file added; no other repo files modified; no commit; no push
- method: inspect real files + execute real commands; unrun checks are marked **NOT RUN**, never PASS

## Verdict

**NO-GO** for claiming the README onboarding / Live-ready product path is release-ready.

Engineering gates on this machine largely passed (`juno:setup`, `juno:doctor` JSON ok, `loop:smoke`, `verify:desktop`, `cargo test`). That is not enough for GO: the documented no-key path mutates a live workbench into a disabled scheduler while doctor can still report `readyForLive: true`, and this HEAD has no green CI evidence.

## Environment (recorded)

| Item | Value |
|------|-------|
| OS | Windows 10.0.26200 |
| Node | `v22.13.1` (engines require `>=22.13.0`) |
| pnpm | `10.13.1` (packageManager / CI pin `10.13.1`) |
| Git | `2.55.0.windows.2` |
| rustc / cargo | `1.96.0` |
| CURSOR_API_KEY | present in local `.env.local` (content not logged) |

Caveat: this is a **warm** machine (deps installed, existing workbench, key configured, prior daemon PID). Cold clone from empty machine was **NOT RUN**.

## Check matrix

| Area | Result | Notes |
|------|--------|-------|
| README / docs surfaces | PASS (file review) | Present and cross-linked; product status already admits packaging is not release-grade |
| LICENSE | PASS (file review) | MIT, © 2026 FranklinNexus |
| SECURITY.md | PASS (file review) | Supported version, private reporting, runtime boundary |
| CONTRIBUTING.md | PASS (file review) | Setup + `verify:desktop` + cargo test expectations |
| `.gitignore` secrets | PASS (file review) | `.env*` ignored; `!.env.example` allowed |
| CI workflow contract | PASS (file review) | `.github/workflows/ci.yml` matches local gates |
| CI green for this HEAD | **FAIL / no evidence** | No runs listed for `codex/result-driven-kpi` or `main`; last visible run failed on another branch |
| `pnpm install --frozen-lockfile` | PASS | Exit 0 under `CI=true` |
| `pnpm juno:setup` | PASS | Exit 0; idempotent; preserved existing workbench state |
| `pnpm juno:doctor` (pre-smoke) | PASS | `readyForSmoke/readyForLive` true; 13 checks |
| `pnpm juno:doctor -- --live` | PASS | Exit 0 |
| `pnpm juno:doctor` (post-smoke) | **PASS with P0 caveat** | Still `readyForLive: true` while `schedulerEnabled: false` |
| `pnpm loop:smoke` | PASS (observed) | Exit 0; **side effects** disable scheduler / empty `now` |
| Direct control `status` / exit codes | PASS | `status` 0; invalid cmd 64; missing mission 5 |
| Direct control full Live `run` | **NOT RUN** | Not re-executed in this audit; prior record exists at `docs/juno-direct-control-e2e.md` but is **not** counted as PASS here |
| `pnpm verify:desktop` | PASS | test, lint, build, dev-smoke, orchestrator:build, cargo check |
| `cargo test --manifest-path src-tauri/Cargo.toml` | PASS | 7 lib tests ok |
| Standalone `pnpm ui:smoke` without server | FAIL (expected) | Needs `localhost:3000`; `loop:smoke` starts its own `pnpm dev` via `runUiSmoke()` |
| Cold clone + no-key path on clean machine | **NOT RUN** | |
| Signed desktop packaging / multi-user auth | **NOT RUN** | README already marks non-release-grade |

## Risk register

### P0

1. **`loop:smoke` disables the Live scheduler and does not restore prior queue/scheduler state**
   Observed after PASS:
   - `E:\AgentWorkbench\state\scheduler.json` → `"enabled": false`, `lastAction: "bootstrap_smoke_loop"`, `lastTickAt: null`
   - `queue/now.yaml` → `now: []` (backup written, not restored by the script)
   - `juno-control status` → `schedulerEnabled: false` while a stale `schedulerPid=62476` may still appear “running”
   README “Try it without an API key” tells users to run `pnpm loop:smoke` without warning that an existing workbench’s autonomy will be stopped.

2. **`juno:doctor` can report Live-ready after smoke has disabled the scheduler**
   Post-smoke doctor: `ok: true`, `readyForLive: true`, `scheduler` check `pass` (`running pid=62476`), **no** `scheduler_heartbeat` check (skipped when `schedulerLastTickAt` is null).
   `readyForLive` only requires zero `fail` checks + key presence; it does **not** require `schedulerEnabled: true` or a fresh heartbeat. This is a false-ready signal for the product claim “diagnose this machine”.

### P1

1. **No green CI evidence for this commit/branch**
   Workflow file is correct on paper (`pnpm install --frozen-lockfile` → `pnpm verify:desktop` → `cargo test`). `gh run list --branch codex/result-driven-kpi` and `--branch main` returned no runs. Last visible run (`30226458837`, branch `codex/pre-push-966d788`) concluded **failure**. Cannot claim “CI contract is functional” as a release fact for this HEAD.

2. **Orchestrator transitive advisory: `undici` high (via `@cursor/sdk`)**
   `npm audit --prefix orchestrator`: 3 vulnerabilities (2 moderate, 1 high). Report: `No fix available` in tree. Blocks claiming a clean dependency security posture for release notes.

3. **Full Live direct-control `run` not re-validated in this audit**
   CLI contract probes passed; end-to-end governed mission was **NOT RUN**. Do not treat `docs/juno-direct-control-e2e.md` as a substitute PASS for this evaluation.

4. **Warm-machine bias**
   Setup/doctor/smoke succeeded on an already-initialized workbench with a key. Cold Windows clone + empty workbench + no key was **NOT RUN**.

### P2

1. Bootstrap script still prints “Ensure: `pnpm dev --port 3000` running before sl02 verify”, but `run-minimal-loop.mjs` `runUiSmoke()` already spawns `pnpm dev --port 3000`. Message is stale / confusing.
2. `node scripts/juno-control.mjs` with no args defaults to `status` (exit 0), not usage/64. Invalid subcommand correctly returns 64.
3. Vitest stderr noise: zustand persist storage unavailable in `mock-feed-connection` tests (tests still passed).
4. pnpm may prompt / warn about ignored build scripts (`esbuild`) and advertises pnpm 11; CI pins 10.13.1 — fine if documented, easy to confuse contributors.

## Area findings

### Onboarding (`juno:setup` / `juno:doctor`)

**PASS** for happy-path execution on this machine; **NO-GO contribution** via post-smoke doctor false-ready (P0).

```text
pnpm juno:setup → EXIT 0
  ok: true
  workbench: E:\AgentWorkbench
  preserved existing queue/state/config; copied .cursor hooks

pnpm juno:doctor (pre-smoke) → EXIT 0
  readyForSmoke: true, readyForLive: true
  summary: passed=13 warnings=0 failed=0
  scheduler: running pid=62476; heartbeat 1s old

pnpm juno:doctor -- --live → EXIT 0
```

### No-key smoke (`loop:smoke`)

**PASS** exit code; **P0 side effects** disqualify product-path GO.

```text
pnpm loop:smoke → EXIT 0
  orchestrator:build PASS
  3 slots dequeued (implement → review → verify)
  pnpm test PASS (48 files / 188 tests)
  check-orchestrator-deps PASS
  ui_smoke PASS (via embedded pnpm dev in runUiSmoke)
  === Minimal loop PASS — queue empty ===
```

Post-condition (actual files):

```json
{
  "enabled": false,
  "lastAction": "bootstrap_smoke_loop",
  "daemonStartedAt": null,
  "lastTickAt": null
}
```

Remediation (operator; not executed by this audit write-up): restore scheduler `enabled: true` / restart `pnpm juno:daemon`, and restore queue from `queue/now.yaml.bak-pre-loop-*` if prior work mattered.

### Direct control

**Partial PASS** (CLI contract only).

| Command | Exit | Outcome |
|---------|------|---------|
| `node scripts/juno-control.mjs status` | 0 | JSON snapshot; mission COMPLETE 4/4 (prior mission) |
| `node scripts/juno-control.mjs` (no args) | 0 | Defaults to status |
| `node scripts/juno-control.mjs foobar` | 64 | `INVALID_COMMAND` |
| `node scripts/juno-control.mjs submit` (no brief) | 64 | `EMPTY_BRIEF` |
| `node scripts/juno-control.mjs wait --mission does-not-exist-xyz` | 5 | `outcome: missing` |
| `node scripts/juno-control.mjs run --brief ...` | **NOT RUN** | |

Post-smoke status showed `schedulerEnabled: false`, `schedulerRunning: true`, `schedulerLastTickAt: null`.

### CI

**Workflow review: PASS. Execution evidence for this HEAD: FAIL / missing.**

`.github/workflows/ci.yml`:

- triggers: `push` to `main` / `codex/**`, and `pull_request`
- `windows-latest`, Node `22.13.1`, pnpm `10.13.1`, Rust stable
- steps match local release gates: frozen install → `pnpm verify:desktop` → `cargo test --manifest-path src-tauri/Cargo.toml`

`gh run list` did not show successful runs for current or `main` branches during this audit.

### README / LICENSE / SECURITY / CONTRIBUTING

**PASS** (presence + content review; not a visual design review).

| File | Observation |
|------|-------------|
| `README.md` | Clone → setup → doctor → loop:smoke; Live doctor; control CLI; links to getting-started / direct-control / e2e; honest “developer preview” limits |
| `LICENSE` | MIT |
| `SECURITY.md` | Preview support on `main`; private vuln reporting; local-only control; `.env.local` / workbench boundaries |
| `CONTRIBUTING.md` | Same onboarding; PR requires `verify:desktop` + cargo tests |
| `.env.example` | Documents paths + optional key; warns never commit `.env.local` |

Mismatch vs reality: README does not warn that `loop:smoke` disables scheduler / replaces `now` queue on a shared workbench.

### Build & test

**PASS** on this machine.

```text
pnpm verify:desktop → EXIT 0
  no orchestrator→parent symlink loop PASS
  pnpm test PASS (48 / 188)
  pnpm lint PASS
  pnpm build PASS (Next.js 16.2.7)
  dev-smoke (Turbopack :3099) PASS
  orchestrator:build PASS
  cargo check PASS

cargo test --manifest-path src-tauri/Cargo.toml → EXIT 0
  app_lib: 7 passed; 0 failed
```

## Commands executed and results

| # | Command | Exit | Result summary |
|---|---------|------|----------------|
| 1 | `node -v` / `pnpm -v` / `git --version` / `rustc --version` / `cargo --version` | 0 | Toolchain as in Environment |
| 2 | File existence probes for README, LICENSE, SECURITY, CONTRIBUTING, CI, scripts | 0 | All required files exist; banner asset exists |
| 3 | `pnpm juno:setup` | 0 | ok; workbench preserved |
| 4 | `pnpm juno:doctor` | 0 | readyForSmoke/Live true (pre-smoke) |
| 5 | `pnpm juno:doctor -- --live` | 0 | ok |
| 6 | `node scripts/juno-control.mjs status` | 0 | COMPLETE snapshot |
| 7 | Invalid / missing control probes | 64 / 5 | Contract matches docs for those cases |
| 8 | `pnpm loop:smoke` | 0 | Minimal loop PASS; scheduler left disabled |
| 9 | `pnpm verify:desktop` | 0 | All desktop gates passed |
| 10 | `cargo test --manifest-path src-tauri/Cargo.toml` | 0 | 7 passed |
| 11 | `CI=true pnpm install --frozen-lockfile` | 0 | Done in 27.8s |
| 12 | `npm audit --prefix orchestrator` | 1 (audit findings) | 1 high / 2 moderate; no fix in tree |
| 13 | `gh run list` (branch + main) | 0 | No green evidence for this HEAD |
| 14 | Post-smoke `pnpm juno:doctor` + `juno-control status` | 0 | readyForLive true; schedulerEnabled false |
| 15 | Standalone `node scripts/ui-smoke.mjs` | 1 | fetch failed (no server); contrasts with loop-embedded smoke |
| 16 | Full Live `juno-control run` | — | **NOT RUN** |
| 17 | Cold clone onboarding | — | **NOT RUN** |

## GO / NO-GO rationale

- **GO would require at least:** smoke that does not silently disable Live scheduling (or README + doctor that make the side effect impossible to miss); doctor failing or warning when `schedulerEnabled` is false / heartbeat missing; green CI on the release candidate commit; and either a fresh no-key cold-path proof or an honest README demotion of that claim.
- **Current state:** local engineering gates are strong; product onboarding/Live-ready narrative is not trustworthy after following the documented smoke step.
- **Conclusion: NO-GO.**

## Explicit non-claims

- Did not perform visual QA of the HUD/UI.
- Did not re-run a Live multi-phase `juno-control run` mission.
- Did not verify GitHub Actions on a clean `windows-latest` runner for `d6aaf8c`.
- Did not fix or re-enable the workbench scheduler after smoke (out of scope: docs-only change).
