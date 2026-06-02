# Juno HUD UI Kit

Institutional terminal component layer. Window modules (`widgets/*`) compose these primitives — do not duplicate HUD styling inside widgets.

## Layers

| Layer | Path | Components |
|-------|------|------------|
| Primitives | `primitives/` | `HudButton`, `HudInput`, `HudSegment`, `HudSelect` |
| Data | `data/` | `DataValue`, `MetricRow`, `DepthRow`, `Sparkline`, `DataTable`, `KpiStrip` |
| Feedback | `feedback/` | `StatusDot`, `LiveBadge`, `ConnectionBadge`, `TagChip`, `EmptyState`, `AlertFrame`, `LoadingRows`, `SkeletonBlock` |
| Feed | `feed/` | `FeedItem`, `ScrollFeed` |
| Layout | `layout/` | `SectionLabel`, `FilterBar` |

## When to use what

- **Toolbar / panel chrome** → `HudButton`, `HudSegment`, `HudSelect`
- **Search / filter row** → `FilterBar` + `HudInput`
- **Ticker strip / header KPIs** → `KpiStrip`
- **Watchlist / positions table** → `DataTable` (dense, mono, row highlight)
- **Order book** → `DepthRow`
- **Spark history** → `Sparkline`
- **Event timeline** → `ScrollFeed` + `FeedItem`
- **WS / feed health** → `ConnectionBadge`
- **Async panel body** → `LoadingRows` until data arrives
- **No data** → `EmptyState` inside `AlertFrame` if critical

## Preview

```bash
pnpm dev
# open http://localhost:3000/dev/components
```

## Import

```ts
import { HudButton, DataTable, ConnectionBadge, KpiStrip } from "@/components/ui";
```

## Not in kit (by design)

Window shell (`PanelWindow`), grid layout (`LayoutCanvas`), and widget business logic stay in `dashboard/` and `widgets/`. Toast / command palette can be added when product needs them.
