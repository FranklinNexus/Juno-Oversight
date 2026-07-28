# Juno-Oversight 受治理产品发布就绪审计（非视觉）

- generatedAtLocal: `2026-07-29T02:58:59+08:00`
- generatedAtUtc: `2026-07-28T18:58:59Z`
- branch: `codex/result-driven-kpi`
- commit: `9d8d325` (`9d8d32522ff9e8e3ee5263405ed3f7b9808330de`)
- repo: `C:\Users\kfr34\Desktop\Entrepreneurship\Active\Juno-Oversight`
- workbench: `E:\AgentWorkbench`
- auditor: local agent on the developer machine (warm checkout; not a cold clone)
- scope: **only** this file added; no other repo files modified; no commit; no push
- method: inspect real files + execute real commands; unrun checks are marked **NOT RUN**, never PASS

## Verdict

**NO-GO** for claiming this HEAD is product-release-ready beyond an honest developer-preview local path.

Local engineering gates on this warm machine passed (`juno:setup`, `juno:doctor`, isolated `loop:smoke`, `verify:desktop`, `cargo test`). Isolated smoke did **not** disable the Live scheduler or replace `queue/now.yaml`. That is still not enough for GO: there is **no green CI evidence** for this branch or `main`, cold-clone onboarding was **NOT RUN**, and a full Live `juno-control run` was **NOT RUN** in this audit. README Product status claiming the “CI contract are functional” is therefore not backed by execution evidence for this release candidate.

## Environment (recorded)

| Item | Value |
|------|-------|
| OS | Windows 10.0.26200 |
| Node | `v22.13.1` (engines require `>=22.13.0`) |
| pnpm | `10.13.1` (packageManager / CI pin `10.13.1`) |
| Git | `2.55.0.windows.2` |
| rustc / cargo | `1.96.0` |
| CURSOR_API_KEY | present in process env and `.env.local` (content not logged) |

Caveat: this is a **warm** machine (deps installed, existing workbench, key configured, prior daemon PID, likely existing `localhost:3000`). Cold clone from empty machine was **NOT RUN**.

## Check matrix

| Area | Result | Notes |
|------|--------|-------|
| README / docs surfaces | PASS (file review) | Present; developer-preview status stated; no-key path documents isolated smoke |
| LICENSE | PASS (file review) | MIT, © 2026 FranklinNexus |
| SECURITY.md | PASS (file review) | Supported version, private reporting, runtime boundary |
| CONTRIBUTING.md | PASS (file review) | Setup + `verify:desktop` + cargo test expectations |
| `.gitignore` secrets | PASS (file review) | `.env*` ignored; `!.env.example` allowed |
| `.env.example` | PASS (file review) | Paths + optional key; warns never commit `.env.local` |
| CI workflow contract | PASS (file review) | `.github/workflows/ci.yml` matches local gates |
| CI green for this HEAD / `main` | **FAIL / no evidence** | `gh run list` empty for branch and `main`; last visible run failed on another branch |
| `CI=true pnpm install --frozen-lockfile` | PASS | Exit 0; lockfile up to date |
| `pnpm juno:setup` | PASS | Exit 0; idempotent; preserved existing workbench state |
| `pnpm juno:doctor` (pre-smoke) | PASS | `readyForSmoke/readyForLive` true; 14 checks; scheduler enabled + heartbeat |
| `pnpm juno:doctor -- --live` | PASS | Exit 0 |
| `pnpm juno:doctor` (post-smoke) | PASS | Still `readyForLive: true`; `schedulerEnabled: true` |
| `pnpm loop:smoke` (`--isolated`) | PASS | Exit 0; temp workbench removed; Live `now.yaml` hash unchanged; Live `enabled` stayed `true` |
| Direct control `status` / exit codes | PASS | `status` 0; invalid cmd 64; empty submit 64; missing mission 5 |
| Direct control full Live `run` | **NOT RUN** | Not re-executed in this audit |
| `pnpm verify:desktop` | PASS | test, lint, build, dev-smoke, orchestrator:build, cargo check |
| `cargo test --manifest-path src-tauri/Cargo.toml` | PASS | 7 lib tests ok |
| `npm audit --prefix orchestrator` | FAIL (advisory) | 3 vulns (2 moderate, 1 high via `undici` / `@cursor/sdk`); no fix in tree |
| Cold clone + no-key path on clean machine | **NOT RUN** | |
| Signed desktop packaging / multi-user auth | **NOT RUN** | README already marks non-release-grade |

## Risk register

### P0

1. **No green CI execution evidence while Product status claims the CI contract is functional**
   Workflow file review PASSes, but `gh run list --branch codex/result-driven-kpi` and `--branch main` returned **no runs**. The only recent visible run (`30226458837`, branch `codex/pre-push-966d788`) concluded **failure**. Treating “CI is functional” as a release fact for this HEAD is unsupported. Blocks GO for any claim that GitHub Actions has validated this candidate.

### P1

1. **Cold-clone onboarding path not proven**
   All setup/doctor/smoke results are on a warm machine with deps, workbench, key, and daemon already present. README’s clone → install → setup → doctor → smoke path was **NOT RUN** from empty state.

2. **Full Live direct-control `run` not re-validated in this audit**
   CLI contract probes passed; end-to-end governed mission was **NOT RUN**. Do not treat prior `docs/juno-direct-control-e2e.md` as a substitute PASS for this evaluation.

3. **Orchestrator transitive advisory: `undici` high (via `@cursor/sdk`)**
   `npm audit --prefix orchestrator`: 3 vulnerabilities (2 moderate, 1 high). Report: `No fix available` in tree. Blocks claiming a clean dependency security posture for release notes.

4. **Non-isolated footgun still exists in the raw script**
   `scripts/run-minimal-loop.mjs` without `--isolated` still targets `defaultWorkbenchRoot()` and can mutate Live queue/scheduler. `pnpm loop:smoke` correctly passes `--isolated`. Users who invoke the script directly without the flag remain at risk; bootstrap still prints “Scheduler left disabled” even for the temp workbench (confusing but Live was not disabled this run).

5. **Warm-machine bias on UI smoke**
   During `loop:smoke`, `ui:smoke` hit `http://localhost:3000/` and PASSed quickly. A pre-existing listener on `:3000` may have satisfied the check. This does not invalidate the overall smoke exit code, but weakens the “cold UI path” claim.

### P2

1. Bootstrap still prints “Ensure: `pnpm dev --port 3000` running before sl02 verify”, while `runUiSmoke()` already spawns `pnpm dev --port 3000`. Message is stale / confusing.
2. `node scripts/juno-control.mjs` with no args defaults to `status` (exit 0), not usage/64. Invalid subcommand correctly returns 64.
3. Vitest stderr noise: zustand persist storage unavailable in `mock-feed-connection` tests (tests still passed).
4. pnpm may warn about ignored build scripts (`esbuild`); CI pins 10.13.1 — fine if documented, easy to confuse contributors.

## Area findings

### Onboarding (`juno:setup` / `juno:doctor`)

**PASS** for happy-path execution on this machine.

```text
pnpm juno:setup → EXIT 0
  ok: true
  workbench: E:\AgentWorkbench
  preserved existing queue/state/config; copied .cursor hooks

pnpm juno:doctor (pre-smoke) → EXIT 0
  readyForSmoke: true, readyForLive: true
  summary: passed=14 warnings=0 failed=0
  scheduler_enabled: enabled; scheduler running; heartbeat present

pnpm juno:doctor -- --live → EXIT 0

pnpm juno:doctor (post-smoke) → EXIT 0
  readyForLive: true; schedulerEnabled: true; heartbeat fresh
```

### No-key smoke (`loop:smoke` / `--isolated`)

**PASS** exit code; **Live workbench isolation verified** on this HEAD.

```text
pnpm loop:smoke → EXIT 0
  uses: node scripts/run-minimal-loop.mjs --isolated
  temp workbench under %TEMP%\juno-smoke-*
  orchestrator:build PASS
  3 slots dequeued (implement → review → verify)
  pnpm test PASS (48 files / 188 tests)
  check-orchestrator-deps PASS
  ui_smoke PASS
  === Minimal loop PASS — queue empty ===
  isolated workbench removed
```

Pre/post Live workbench hashes:

| File | Pre SHA256 | Post | Match |
|------|------------|------|-------|
| `queue/now.yaml` | `5AAFCAEC…` | same | **yes** |
| `state/orchestrator.json` | `42E16071…` | same | **yes** |
| `state/scheduler.json` | `43165F46…` | `E925004A…` | no (only `lastTickAt` advanced by Live daemon; `enabled` remained `true`) |

Conclusion: README claim that `loop:smoke` “runs in a temporary isolated workbench and cannot replace the configured Live queue or disable the Live scheduler” matches observed behavior for `pnpm loop:smoke` on `9d8d325`.

### Direct control

**Partial PASS** (CLI contract only).

| Command | Exit | Outcome |
|---------|------|---------|
| `node scripts/juno-control.mjs status` | 0 | JSON snapshot; mission ACTIVE 1/4 (this mission) |
| `node scripts/juno-control.mjs` (no args) | 0 | Defaults to status |
| `node scripts/juno-control.mjs foobar` | 64 | `INVALID_COMMAND` |
| `node scripts/juno-control.mjs submit` (no brief) | 64 | `EMPTY_BRIEF` |
| `node scripts/juno-control.mjs wait --mission does-not-exist-xyz` | 5 | `outcome: missing` |
| `node scripts/juno-control.mjs status --mission juno-brief-20260728-对当前-juno-oversight-6dd7cbc0` | 0 | ACTIVE; p02 running |
| `node scripts/juno-control.mjs run --brief ...` | **NOT RUN** | |

### CI

**Workflow review: PASS. Execution evidence for this HEAD / `main`: FAIL / missing.**

`.github/workflows/ci.yml`:

- triggers: `push` to `main` / `codex/**`, and `pull_request`
- `windows-latest`, Node `22.13.1`, pnpm `10.13.1`, Rust stable
- steps match local release gates: frozen install → `pnpm verify:desktop` → `cargo test --manifest-path src-tauri/Cargo.toml`

```text
gh run list --branch codex/result-driven-kpi --limit 10 → (empty)
gh run list --branch main --limit 10 → (empty)
gh run list --limit 5 → 1 run: 30226458837 failure on codex/pre-push-966d788
```

### README / LICENSE / SECURITY / CONTRIBUTING

**PASS** (presence + content review; not a visual design review).

| File | Observation |
|------|-------------|
| `README.md` | Clone → setup → doctor → loop:smoke; documents isolated smoke; Live doctor; control CLI; honest developer-preview limits |
| `LICENSE` | MIT |
| `SECURITY.md` | Preview support on `main`; private vuln reporting; local-only control; `.env.local` / workbench boundaries |
| `CONTRIBUTING.md` | Same onboarding; PR requires `verify:desktop` + cargo tests |
| `.env.example` | Documents paths + optional key; warns never commit `.env.local` |

Mismatch vs evidence: Product status says CI contract is functional, but this audit found no green Actions runs for the candidate branch or `main`.

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

CI=true pnpm install --frozen-lockfile → EXIT 0
```

## Commands executed and results

| # | Command | Exit | Result summary |
|---|---------|------|----------------|
| 1 | `node -v` / `pnpm -v` / `git --version` / `rustc --version` / `cargo --version` | 0 | Toolchain as in Environment |
| 2 | File existence probes for README, LICENSE, SECURITY, CONTRIBUTING, CI, scripts, banner | 0 | All required files exist |
| 3 | Pre-smoke hash/snapshot of Live `scheduler.json` / `now.yaml` / `orchestrator.json` | 0 | `enabled: true`; this mission queued |
| 4 | `pnpm juno:setup` | 0 | ok; workbench preserved |
| 5 | `pnpm juno:doctor` | 0 | readyForSmoke/Live true; 14 pass |
| 6 | `pnpm juno:doctor -- --live` | 0 | ok |
| 7 | `node scripts/juno-control.mjs status` (+ mission / invalid / missing probes) | 0 / 64 / 5 | Contract matches docs for those cases |
| 8 | `pnpm loop:smoke` | 0 | Minimal loop PASS; Live queue unchanged; Live scheduler stayed enabled |
| 9 | Post-smoke hashes + `pnpm juno:doctor` | 0 | Isolation confirmed; doctor still Live-ready |
| 10 | `pnpm verify:desktop` | 0 | All desktop gates passed |
| 11 | `cargo test --manifest-path src-tauri/Cargo.toml` | 0 | 7 passed |
| 12 | `CI=true pnpm install --frozen-lockfile` | 0 | Done in ~0.5s |
| 13 | `npm audit --prefix orchestrator` | 1 (audit findings) | 1 high / 2 moderate; no fix in tree |
| 14 | `gh run list` (branch + main + recent) | 0 | No green evidence for this HEAD / main |
| 15 | Full Live `juno-control run` | — | **NOT RUN** |
| 16 | Cold clone onboarding | — | **NOT RUN** |

## GO / NO-GO rationale

- **GO would require at least:** green CI on the release-candidate commit (or `main`); cold-clone proof of the documented no-key path; and either a fresh Live `juno-control run` acceptance or an honest demotion of that claim in Product status. Dependency advisory posture should be acknowledged in release notes if still unfixed.
- **Current state:** local developer-preview engineering gates and isolated no-key smoke are strong on this warm machine; Live isolation for `pnpm loop:smoke` matches README. Release / CI narrative is not trustworthy without Actions evidence.
- **Conclusion: NO-GO.**

## Explicit non-claims

- Did not perform visual QA of the HUD/UI.
- Did not re-run a Live multi-phase `juno-control run` mission.
- Did not verify GitHub Actions on a clean `windows-latest` runner for `9d8d325`.
- Did not cold-clone onto a clean Windows machine.
- Did not modify product code or other docs (audit write-up only).
- Did not treat `docs/direct-agent-baseline-evaluation.md` as evidence; conclusions were re-measured on this HEAD.
