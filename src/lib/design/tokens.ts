/**
 * Juno HUD design tokens (mirror of CSS variables in globals.css).
 * Use CSS vars in components; use this object for docs / devtools.
 */
export const hudTokens = {
  color: {
    bgBase: "#0b0c0e",
    bgPanel: "#111318",
    bgElevated: "#161a22",
    bgHover: "#1a1f28",
    borderDim: "#242a33",
    borderStrong: "#3a424f",
    textPorcelain: "#ddd9d0",
    textMuted: "#7a808a",
    accentGold: "#c9a227",
    statusOk: "#4f6b57",
    statusWarn: "#8a4a42",
    up: "#6f8f78",
    down: "#9a6d6d",
    bid: "#6f8f78",
    ask: "#9a6d6d",
  },
  typography: {
    label: "10px",
    body: "11px",
    data: "11px",
    header: "12px",
    trackingLabel: "0.12em",
    trackingWide: "0.14em",
  },
  space: {
    unit: 4,
    panelPadding: 8,
    gridGap: 2,
  },
  motion: {
    fast: "120ms",
    normal: "180ms",
    easing: "cubic-bezier(0.22, 1, 0.36, 1)",
  },
} as const;

export type HudSemantic = "default" | "ok" | "warn" | "danger" | "gold" | "up" | "down" | "muted";

export const semanticClass: Record<HudSemantic, string> = {
  default: "text-[var(--text-porcelain)]",
  ok: "text-[var(--status-ok)]",
  warn: "text-[var(--status-warn)]",
  danger: "text-[var(--down)]",
  gold: "text-[var(--accent-gold)]",
  up: "text-[var(--up)]",
  down: "text-[var(--down)]",
  muted: "text-[var(--text-muted)]",
};
