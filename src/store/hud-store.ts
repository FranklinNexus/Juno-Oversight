"use client";

import { create } from "zustand";
import { persist } from "zustand/middleware";
import { applyHudTheme, type HudTheme } from "@/lib/theme/hud-themes";

export type HudMode = "surveillance" | "focus";
export type MarketDataMode = "mock" | "live";

type HudStore = {
  mode: HudMode;
  theme: HudTheme;
  marketDataMode: MarketDataMode;
  wsConnected: boolean;
  wsLatencyMs: number;
  uiScale: number;
  autoFit: boolean;
  setMode: (mode: HudMode) => void;
  setTheme: (theme: HudTheme) => void;
  setMarketDataMode: (mode: MarketDataMode) => void;
  toggleMarketDataMode: () => void;
  setConnection: (connected: boolean, latencyMs: number) => void;
  applyUiScale: (scale: number) => void;
  setUiScale: (scale: number) => void;
  bumpUiScale: (delta: number) => void;
  setAutoFit: (enabled: boolean) => void;
};

const clampScale = (scale: number) => Math.max(0.75, Math.min(1.35, Number(scale.toFixed(2))));

export const useHudStore = create<HudStore>()(
  persist(
    (set, get) => ({
      mode: "surveillance",
      theme: "night",
      marketDataMode: "live",
      wsConnected: false,
      wsLatencyMs: 0,
      uiScale: 1,
      autoFit: true,
      setMode: (mode) => set({ mode }),
      setTheme: (theme) => {
        applyHudTheme(theme);
        set({ theme });
      },
      setMarketDataMode: (marketDataMode) => set({ marketDataMode }),
      toggleMarketDataMode: () =>
        set((state) => ({
          marketDataMode: state.marketDataMode === "live" ? "mock" : "live",
        })),
      setConnection: (connected, latencyMs) =>
        set({ wsConnected: connected, wsLatencyMs: latencyMs }),
      applyUiScale: (scale) => set({ uiScale: clampScale(scale) }),
      setUiScale: (scale) => set({ uiScale: clampScale(scale), autoFit: false }),
      bumpUiScale: (delta) => {
        const next = clampScale(get().uiScale + delta);
        set({ uiScale: next, autoFit: false });
      },
      setAutoFit: (enabled) => set({ autoFit: enabled }),
    }),
    {
      name: "juno-hud-prefs",
      partialize: (state) => ({ theme: state.theme, marketDataMode: state.marketDataMode }),
      onRehydrateStorage: () => (state) => {
        if (state?.theme) applyHudTheme(state.theme);
      },
    },
  ),
);
