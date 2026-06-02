"use client";

import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { Layout } from "react-grid-layout";
import {
  GRID_MAX_ROWS,
  SIZE_PRESETS,
  type PanelSizePreset,
} from "@/lib/layout/constants";
import {
  DEFAULT_PANELS,
  LAYOUT_PRESETS,
  type LayoutPresetId,
} from "@/lib/layout/presets";
import { clampPanel } from "@/lib/layout/clamp-panel";
import type { PanelState } from "@/lib/layout/types";
import type { WidgetType } from "@/lib/layout/widget-registry";

export type { PanelState };
export { clampPanel };

type PanelBounds = Pick<PanelState, "x" | "y" | "w" | "h">;

type LayoutStore = {
  panels: PanelState[];
  savedSnapshot: PanelState[] | null;
  maximizeCache: Record<string, PanelBounds>;
  syncLayout: (layout: Layout) => void;
  addPanel: (widgetType?: WidgetType) => void;
  removePanel: (id: string) => void;
  setPanelSize: (id: string, preset: PanelSizePreset) => void;
  setWidgetType: (id: string, widgetType: WidgetType) => void;
  toggleMaximize: (id: string) => void;
  saveCurrentLayout: () => void;
  restoreSavedLayout: () => void;
  applyLayoutPreset: (preset: LayoutPresetId) => void;
  resetLayout: () => void;
};

function clonePanels(panels: PanelState[]): PanelState[] {
  return panels.map((panel) => ({ ...panel }));
}

function findNextPosition(panels: PanelState[], size: { w: number; h: number }) {
  if (panels.length === 0) return { x: 0, y: 0 };
  const maxY = Math.max(...panels.map((panel) => panel.y + panel.h), 0);
  return { x: 0, y: Math.min(maxY, GRID_MAX_ROWS - size.h) };
}

function withFreshIds(panels: PanelState[]): PanelState[] {
  const stamp = Date.now();
  return panels.map((panel, index) => ({
    ...panel,
    i: `panel-${panel.widgetType}-${stamp}-${index}`,
  }));
}

export const useLayoutStore = create<LayoutStore>()(
  persist(
    (set, get) => ({
      panels: clonePanels(DEFAULT_PANELS),
      savedSnapshot: null,
      maximizeCache: {},
      syncLayout: (layout) => {
        const map = new Map(layout.map((item) => [item.i, item]));
        set({
          panels: get().panels.map((panel) => {
            const next = map.get(panel.i);
            if (!next) return panel;
            return clampPanel({
              ...panel,
              x: next.x,
              y: next.y,
              w: next.w,
              h: next.h,
            });
          }),
        });
      },
      addPanel: (widgetType = "market") => {
        const size = SIZE_PRESETS.quarter;
        const position = findNextPosition(get().panels, size);
        const panel: PanelState = {
          i: `panel-${Date.now()}`,
          widgetType,
          ...position,
          ...size,
        };
        set({ panels: [...get().panels, clampPanel(panel)], maximizeCache: {} });
      },
      removePanel: (id) => {
        const panels = get().panels;
        if (panels.length <= 1) return;
        const restCache = { ...get().maximizeCache };
        delete restCache[id];
        set({
          panels: panels.filter((panel) => panel.i !== id),
          maximizeCache: restCache,
        });
      },
      setPanelSize: (id, preset) => {
        const size = SIZE_PRESETS[preset];
        const restCache = { ...get().maximizeCache };
        delete restCache[id];
        set({
          panels: get().panels.map((panel) =>
            panel.i === id ? clampPanel({ ...panel, ...size }) : panel,
          ),
          maximizeCache: restCache,
        });
      },
      setWidgetType: (id, widgetType) => {
        set({
          panels: get().panels.map((panel) =>
            panel.i === id ? { ...panel, widgetType } : panel,
          ),
        });
      },
      toggleMaximize: (id) => {
        const panels = get().panels;
        const panel = panels.find((item) => item.i === id);
        if (!panel) return;

        const cache = get().maximizeCache;
        if (cache[id]) {
          const prev = cache[id];
          const restCache = { ...cache };
          delete restCache[id];
          set({
            panels: panels.map((item) =>
              item.i === id ? clampPanel({ ...item, ...prev }) : item,
            ),
            maximizeCache: restCache,
          });
          return;
        }

        const full = SIZE_PRESETS.full;
        set({
          maximizeCache: {
            ...cache,
            [id]: { x: panel.x, y: panel.y, w: panel.w, h: panel.h },
          },
          panels: panels.map((item) =>
            item.i === id
              ? clampPanel({ ...item, x: 0, y: 0, w: full.w, h: full.h })
              : item,
          ),
        });
      },
      saveCurrentLayout: () => {
        set({ savedSnapshot: clonePanels(get().panels) });
      },
      restoreSavedLayout: () => {
        const snapshot = get().savedSnapshot;
        if (!snapshot) return;
        set({ panels: clonePanels(snapshot), maximizeCache: {} });
      },
      applyLayoutPreset: (preset) => {
        set({
          panels: clonePanels(withFreshIds(LAYOUT_PRESETS[preset].panels)),
          maximizeCache: {},
        });
      },
      resetLayout: () => {
        set({
          panels: clonePanels(DEFAULT_PANELS),
          maximizeCache: {},
        });
      },
    }),
    {
      name: "juno-layout-store",
      version: 2,
      migrate: (persisted, version) => {
        if (version < 2 || !persisted || typeof persisted !== "object") {
          return {
            panels: clonePanels(DEFAULT_PANELS),
            savedSnapshot: null,
          };
        }
        const state = persisted as {
          panels?: PanelState[];
          savedSnapshot?: PanelState[] | null;
        };
        const panels = Array.isArray(state.panels)
          ? state.panels.map(clampPanel)
          : clonePanels(DEFAULT_PANELS);
        return {
          panels,
          savedSnapshot: Array.isArray(state.savedSnapshot)
            ? state.savedSnapshot.map(clampPanel)
            : null,
        };
      },
      partialize: (state) => ({
        panels: state.panels,
        savedSnapshot: state.savedSnapshot,
      }),
    },
  ),
);

export function panelsToGridLayout(panels: PanelState[]): Layout {
  return panels.map(({ i, x, y, w, h }) => ({
    i,
    x,
    y,
    w,
    h,
    minW: 3,
    minH: 2,
  }));
}
