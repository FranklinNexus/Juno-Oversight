"use client";

import type { ReactElement } from "react";
import { HudButton } from "@/components/ui";
import { HUD_THEME_LABELS, nextHudTheme, type HudTheme } from "@/lib/theme/hud-themes";
import { useHudStore } from "@/store/hud-store";

function NightIcon() {
  return (
    <svg width={14} height={14} viewBox="0 0 14 14" aria-hidden>
      <path
        d="M9.2 1.4a5.2 5.2 0 1 0 3.4 8.9A6.4 6.4 0 1 1 9.2 1.4Z"
        fill="currentColor"
      />
    </svg>
  );
}

function SaturnIcon() {
  return (
    <svg width={14} height={14} viewBox="0 0 14 14" aria-hidden>
      <circle cx={7} cy={7} r={2.6} fill="currentColor" />
      <ellipse
        cx={7}
        cy={7.6}
        rx={5.8}
        ry={1.5}
        fill="none"
        stroke="currentColor"
        strokeWidth={1}
        opacity={0.9}
      />
    </svg>
  );
}

function DayIcon() {
  return (
    <svg width={14} height={14} viewBox="0 0 14 14" aria-hidden>
      <circle cx={7} cy={7} r={2.4} fill="currentColor" />
      <g stroke="currentColor" strokeWidth={1} strokeLinecap="round">
        <line x1={7} y1={1} x2={7} y2={2.4} />
        <line x1={7} y1={11.6} x2={7} y2={13} />
        <line x1={1} y1={7} x2={2.4} y2={7} />
        <line x1={11.6} y1={7} x2={13} y2={7} />
        <line x1={2.8} y1={2.8} x2={3.8} y2={3.8} />
        <line x1={10.2} y1={10.2} x2={11.2} y2={11.2} />
        <line x1={10.2} y1={3.8} x2={11.2} y2={2.8} />
        <line x1={2.8} y1={11.2} x2={3.8} y2={10.2} />
      </g>
    </svg>
  );
}

const THEME_ICONS: Record<HudTheme, () => ReactElement> = {
  night: NightIcon,
  saturn: SaturnIcon,
  day: DayIcon,
};

export function HudThemeToggle() {
  const theme = useHudStore((state) => state.theme);
  const setTheme = useHudStore((state) => state.setTheme);

  const Icon = THEME_ICONS[theme];
  const next = nextHudTheme(theme);

  return (
    <HudButton
      variant="ghost"
      className="w-6 h-6 p-0 flex items-center justify-center text-[var(--accent-gold)] hover:text-[var(--accent-gold-bright,var(--accent-gold))]"
      aria-label={`主题：${HUD_THEME_LABELS[theme]}，点击切换为${HUD_THEME_LABELS[next]}`}
      title={`${HUD_THEME_LABELS[theme]} → ${HUD_THEME_LABELS[next]}`}
      onClick={() => setTheme(next)}
    >
      <Icon />
    </HudButton>
  );
}
