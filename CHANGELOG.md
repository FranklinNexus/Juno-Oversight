# Changelog

All notable product changes are documented here. Juno currently follows developer-preview versioning.

## 0.1.0 - 2026-07-29

### Added

- Local machine-readable control commands: `status`, `submit`, `wait`, and `run`.
- Idempotent `juno:setup` and machine-readable `juno:doctor` onboarding commands.
- Four-stage natural-language missions with durable plan, implement, review, and verify checkpoints.
- Single-instance scheduler with persisted worker PID and deterministic terminal states.
- Windows logon startup, bounded retries, safety hooks, and human-confirmed promote defaults.
- Windows CI, security policy, contribution guide, and MIT license.

### Verified

- A real four-stage repository task completed with review and verify PASS, an empty queue, and no worker
  process left behind. See `docs/juno-direct-control-e2e.md`.
