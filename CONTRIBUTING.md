# Contributing to Juno

Juno is a Windows-first developer preview. Keep changes scoped, auditable, and compatible with the
deterministic review and verify gates.

## Development setup

```powershell
pnpm install
pnpm juno:setup
pnpm juno:doctor
pnpm loop:smoke
```

Live missions additionally require `CURSOR_API_KEY` in `.env.local`.

## Before opening a pull request

```powershell
pnpm verify:desktop
cargo test --manifest-path src-tauri/Cargo.toml
```

Include tests for runtime state transitions and failure behavior. Do not commit `.env.local`, workbench
state, API keys, generated run transcripts, or unrelated local changes.

## Pull request expectations

- Explain the user-visible outcome and failure behavior.
- List the files and state contracts changed.
- Include the exact verification commands and results.
- Call out changes to scope locks, destructive-operation hooks, auto-push, or promote behavior.
