# Juno Oversight HUD (Phase 1)

High-density tactical dashboard scaffold built with Next.js + Tailwind + Zustand.

## Run

```bash
pnpm install
pnpm dev          # browser-only
pnpm tauri:dev    # desktop shell + Next.js
```

Open [http://localhost:3000](http://localhost:3000) for browser mode.

## Implemented in Phase 1

- Tactical dark design system with White Porcelain and Pizza Gold accents
- Bento CSS Grid dashboard layout
- Global mode switch (`Omni-Surveillance` / `Deep Focus`)
- Mock websocket-driven `Alpha Market Ingestor` (Widget A)
- Mock websocket-driven `GitHub Radar` (Widget B)
- Placeholder shells for `Infrastructure Telemetry` (Widget C) and `Application Integration Slot` (Widget D)

## Next Phase

- Tauri integration via `src-tauri/`
- Real market and GitHub websocket feeds
- Real edge-node telemetry (Jupiter) and iframe embed hardening
