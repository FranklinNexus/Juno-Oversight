export type HudTheme = "night" | "saturn" | "day";

export const HUD_THEME_ORDER: HudTheme[] = ["night", "saturn", "day"];

export const HUD_THEME_LABELS: Record<HudTheme, string> = {
  night: "夜间终端",
  saturn: "土星金",
  day: "日间",
};

export function nextHudTheme(current: HudTheme): HudTheme {
  const index = HUD_THEME_ORDER.indexOf(current);
  return HUD_THEME_ORDER[(index + 1) % HUD_THEME_ORDER.length];
}

export function applyHudTheme(theme: HudTheme) {
  if (typeof document === "undefined") return;
  document.documentElement.dataset.hudTheme = theme;
}

export function readPersistedHudTheme(): HudTheme | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem("juno-hud-prefs");
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { state?: { theme?: string } };
    const theme = parsed.state?.theme;
    if (theme === "night" || theme === "saturn" || theme === "day") return theme;
  } catch {
    /* ignore */
  }
  return null;
}
