# Security Policy

## Supported version

Juno is currently a developer preview. Security fixes are applied to the latest commit on `main`.

## Reporting a vulnerability

Do not open a public issue for secrets exposure, command-injection paths, sandbox escapes, or unsafe
filesystem behavior. Use GitHub's private vulnerability reporting for this repository and include:

- the affected command and operating system;
- a minimal reproduction;
- the files or workbench paths that may be exposed;
- whether a Cursor/OpenAI key, repository, or Vault path is at risk.

## Runtime boundary

- The control CLI is local-only and does not expose an unauthenticated HTTP control port.
- Secrets belong in `.env.local`; that file is gitignored.
- Workbench output stays outside the repository.
- Promote remains human-confirmed by default.
- Cursor hooks block destructive shell patterns and writes outside the configured Vault boundary.

These controls reduce risk; they are not a general-purpose sandbox. Run Juno with a dedicated workbench
and a source-control branch, and review scope locks before enabling unattended missions.
