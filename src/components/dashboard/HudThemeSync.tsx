"use client";

import { useEffect } from "react";
import { applyHudTheme } from "@/lib/theme/hud-themes";
import { useHudStore } from "@/store/hud-store";

/** Applies `data-hud-theme` on the document when store theme changes. */
export function HudThemeSync() {
  const theme = useHudStore((state) => state.theme);

  useEffect(() => {
    applyHudTheme(theme);
  }, [theme]);

  return null;
}
