"use client";

import { create } from "zustand";

export type HudMode = "surveillance" | "focus";

type HudStore = {
  mode: HudMode;
  wsConnected: boolean;
  wsLatencyMs: number;
  uiScale: number;
  autoFit: boolean;
  setMode: (mode: HudMode) => void;
  setConnection: (connected: boolean, latencyMs: number) => void;
  applyUiScale: (scale: number) => void;
  setUiScale: (scale: number) => void;
  bumpUiScale: (delta: number) => void;
  setAutoFit: (enabled: boolean) => void;
};

const clampScale = (scale: number) => Math.max(0.75, Math.min(1.35, Number(scale.toFixed(2))));

export const useHudStore = create<HudStore>((set, get) => ({
  mode: "surveillance",
  wsConnected: false,
  wsLatencyMs: 0,
  uiScale: 1,
  autoFit: true,
  setMode: (mode) => set({ mode }),
  setConnection: (connected, latencyMs) =>
    set({ wsConnected: connected, wsLatencyMs: latencyMs }),
  applyUiScale: (scale) => set({ uiScale: clampScale(scale) }),
  setUiScale: (scale) => set({ uiScale: clampScale(scale), autoFit: false }),
  bumpUiScale: (delta) => {
    const next = clampScale(get().uiScale + delta);
    set({ uiScale: next, autoFit: false });
  },
  setAutoFit: (enabled) => set({ autoFit: enabled }),
}));
