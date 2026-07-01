"use client";

import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { Layout } from "react-grid-layout";
import {
  GRID_COLS,
  GRID_MAX_ROWS,
  SIZE_PRESETS,
  type PanelSizePreset,
} from "@/lib/layout/constants";
import { clampPanel } from "@/lib/layout/clamp-panel";
import { bumpPanelZoom, clampPanelZoom } from "@/lib/layout/panel-zoom";
import {
  DEFAULT_PANELS,
  LAYOUT_PRESETS,
  type LayoutPresetId,
} from "@/lib/layout/presets";
import { pulseSizeAnimation } from "@/lib/layout/size-animation";
import {
  dedupePinnedSymbolPanels,
  findPinnedSymbolPanel,
  findSymbolPopoutPosition,
  nextStackOrder,
  normalizeSymbolPopoutPanel,
  SYMBOL_POPOUT_SIZE,
} from "@/lib/layout/symbol-popout-layout";
import type { PanelState } from "@/lib/layout/types";
import type { WidgetType } from "@/lib/layout/widget-registry";
import { normalizeWidgetType } from "@/lib/layout/widget-registry";

export type { PanelState };
export { clampPanel };

type PanelBounds = Pick<PanelState, "x" | "y" | "w" | "h">;

type LayoutStore = {
  panels: PanelState[];
  savedSnapshot: PanelState[] | null;
  maximizeCache: Record<string, PanelBounds>;
  sizeAnimPanelId: string | null;
  focusPanelId: string | null;
  syncLayout: (layout: Layout) => void;
  clearFocusPanel: () => void;
  addPanel: (widgetType?: WidgetType) => void;
  spawnMarketSymbolPanel: (symbol: string, options?: { forceNew?: boolean }) => void;
  bringPanelToFront: (id: string) => void;
  removePanel: (id: string) => void;
  setPanelSize: (id: string, preset: PanelSizePreset) => void;
  bumpPanelGrid: (id: string, deltaW: number, deltaH: number) => void;
  bumpPanelContentZoom: (id: string, deltaY: number) => void;
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

function ensureContentZoom(panel: PanelState): PanelState {
  return {
    ...panel,
    contentZoom: clampPanelZoom(panel.contentZoom ?? 1),
    stackOrder: panel.stackOrder ?? 0,
  };
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

function triggerSizeAnim(
  set: (partial: Partial<LayoutStore> | ((state: LayoutStore) => Partial<LayoutStore>)) => void,
  panelId: string,
) {
  pulseSizeAnimation(
    panelId,
    (id) => set({ sizeAnimPanelId: id }),
    () => set({ sizeAnimPanelId: null }),
  );
}

function updatePanel(
  panels: PanelState[],
  id: string,
  patch: Partial<PanelState>,
): PanelState[] {
  return panels.map((panel) =>
    panel.i === id ? ensureContentZoom(clampPanel({ ...panel, ...patch })) : panel,
  );
}

export const useLayoutStore = create<LayoutStore>()(
  persist(
    (set, get) => ({
      panels: clonePanels(DEFAULT_PANELS).map(ensureContentZoom),
      savedSnapshot: null,
      maximizeCache: {},
      sizeAnimPanelId: null,
      focusPanelId: null,
      clearFocusPanel: () => set({ focusPanelId: null }),
      syncLayout: (layout) => {
        const map = new Map(layout.map((item) => [item.i, item]));
        set({
          panels: get().panels.map((panel) => {
            const next = map.get(panel.i);
            if (!next) return panel;
            return ensureContentZoom(
              clampPanel({
                ...panel,
                x: next.x,
                y: next.y,
                w: next.w,
                h: next.h,
              }),
            );
          }),
        });
      },
      addPanel: (widgetType: WidgetType = "runqueue") => {
        const size = SIZE_PRESETS.quarter;
        const position = findNextPosition(get().panels, size);
        const panel: PanelState = {
          i: `panel-${Date.now()}`,
          widgetType,
          contentZoom: 1,
          ...position,
          ...size,
        };
        set({ panels: [...get().panels, ensureContentZoom(clampPanel(panel))], maximizeCache: {} });
      },
      spawnMarketSymbolPanel: (symbol, options) => {
        const panels = dedupePinnedSymbolPanels(get().panels);
        const existing = findPinnedSymbolPanel(panels, symbol);

        if (existing && !options?.forceNew) {
          const focused = ensureContentZoom(
            clampPanel(
              normalizeSymbolPopoutPanel({
                ...existing,
                stackOrder: nextStackOrder(panels),
              }),
            ),
          );
          set({
            panels: panels.map((panel) => (panel.i === existing.i ? focused : panel)),
            focusPanelId: existing.i,
            maximizeCache: {},
          });
          triggerSizeAnim(set, existing.i);
          return;
        }

        const size = SYMBOL_POPOUT_SIZE;
        const position = findSymbolPopoutPosition(panels, size);
        const panel: PanelState = {
          i: `panel-mkt-${symbol.replace(/[^a-zA-Z0-9]/g, "_")}-${Date.now()}`,
          widgetType: "market",
          pinnedSymbol: symbol,
          contentZoom: 1,
          stackOrder: nextStackOrder(panels),
          ...position,
          ...size,
        };
        set({
          panels: [...panels, ensureContentZoom(clampPanel(panel))],
          focusPanelId: panel.i,
          maximizeCache: {},
        });
        triggerSizeAnim(set, panel.i);
      },
      bringPanelToFront: (id) => {
        const panels = get().panels;
        const target = panels.find((panel) => panel.i === id);
        if (!target) return;
        const top = nextStackOrder(panels);
        if ((target.stackOrder ?? 0) >= top) return;
        set({
          panels: panels.map((panel) =>
            panel.i === id ? { ...panel, stackOrder: top } : panel,
          ),
        });
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
        const cache = { ...get().maximizeCache };
        if (cache[id]) delete cache[id];
        set({
          panels: updatePanel(get().panels, id, size),
          maximizeCache: cache,
        });
        triggerSizeAnim(set, id);
      },
      bumpPanelGrid: (id, deltaW, deltaH) => {
        const panel = get().panels.find((item) => item.i === id);
        if (!panel) return;
        const cache = { ...get().maximizeCache };
        if (cache[id]) delete cache[id];
        set({
          panels: updatePanel(get().panels, id, {
            w: panel.w + deltaW,
            h: panel.h + deltaH,
          }),
          maximizeCache: cache,
        });
        triggerSizeAnim(set, id);
      },
      bumpPanelContentZoom: (id, deltaY) => {
        const panel = get().panels.find((item) => item.i === id);
        if (!panel) return;
        set({
          panels: updatePanel(get().panels, id, {
            contentZoom: bumpPanelZoom(panel.contentZoom ?? 1, deltaY),
          }),
        });
      },
      setWidgetType: (id, widgetType) => {
        set({
          panels: get().panels.map((panel) =>
            panel.i === id
              ? {
                  ...panel,
                  widgetType,
                  pinnedSymbol: widgetType === "market" ? panel.pinnedSymbol : undefined,
                }
              : panel,
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
              item.i === id ? ensureContentZoom(clampPanel({ ...item, ...prev })) : item,
            ),
            maximizeCache: restCache,
          });
          triggerSizeAnim(set, id);
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
              ? ensureContentZoom(clampPanel({ ...item, x: 0, y: 0, w: full.w, h: full.h }))
              : item,
          ),
        });
        triggerSizeAnim(set, id);
      },
      saveCurrentLayout: () => {
        set({ savedSnapshot: clonePanels(get().panels) });
      },
      restoreSavedLayout: () => {
        const snapshot = get().savedSnapshot;
        if (!snapshot) return;
        set({ panels: clonePanels(snapshot).map(ensureContentZoom), maximizeCache: {} });
      },
      applyLayoutPreset: (preset) => {
        set({
          panels: clonePanels(withFreshIds(LAYOUT_PRESETS[preset].panels)).map(ensureContentZoom),
          maximizeCache: {},
        });
      },
      resetLayout: () => {
        set({
          panels: clonePanels(DEFAULT_PANELS).map(ensureContentZoom),
          maximizeCache: {},
        });
      },
    }),
    {
      name: "juno-layout-store",
      version: 6,
      migrate: (persisted, version) => {
        const base =
          version < 2 || !persisted || typeof persisted !== "object"
            ? { panels: clonePanels(DEFAULT_PANELS), savedSnapshot: null }
            : (() => {
                const state = persisted as {
                  panels?: PanelState[];
                  savedSnapshot?: PanelState[] | null;
                };
                const panels = Array.isArray(state.panels)
                  ? state.panels.map((panel) => ensureContentZoom(clampPanel(panel)))
                  : clonePanels(DEFAULT_PANELS);
                return {
                  panels,
                  savedSnapshot: Array.isArray(state.savedSnapshot)
                    ? state.savedSnapshot.map((panel) => ensureContentZoom(clampPanel(panel)))
                    : null,
                };
              })();

        if (version < 3) {
          base.panels = base.panels.map((panel) => ({
            ...panel,
            contentZoom: clampPanelZoom(panel.contentZoom ?? 1),
          }));
        }

        if (version < 5) {
          base.panels = base.panels.map((panel, index) => {
            const stackOrder = panel.stackOrder ?? index + 1;
            if (!panel.pinnedSymbol) return { ...panel, stackOrder };
            const size =
              panel.h < SYMBOL_POPOUT_SIZE.h
                ? SYMBOL_POPOUT_SIZE
                : { w: panel.w, h: panel.h };
            const position =
              panel.x < GRID_COLS - 4
                ? findSymbolPopoutPosition(
                    base.panels.filter((p) => p.i !== panel.i),
                    size,
                  )
                : { x: panel.x, y: panel.y };
            return { ...panel, stackOrder, ...size, ...position };
          });
        }

        base.panels = dedupePinnedSymbolPanels(
          base.panels.map((panel) =>
            panel.pinnedSymbol ? normalizeSymbolPopoutPanel(panel) : panel,
          ),
        );

        return base;
      },
      merge: (persisted, current) => {
        if (!persisted || typeof persisted !== "object") return current;
        const state = persisted as {
          panels?: PanelState[];
          savedSnapshot?: PanelState[] | null;
        };
        const panels = dedupePinnedSymbolPanels(
          (Array.isArray(state.panels)
            ? state.panels.map((panel) => ensureContentZoom(clampPanel(panel)))
            : current.panels
          ).map((panel) =>
            panel.pinnedSymbol ? normalizeSymbolPopoutPanel(panel) : panel,
          ),
        );
        return {
          ...current,
          panels,
          savedSnapshot: Array.isArray(state.savedSnapshot)
            ? state.savedSnapshot.map((panel) => ensureContentZoom(clampPanel(panel)))
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
  return panels.map(({ i, x, y, w, h, pinnedSymbol }) => ({
    i,
    x,
    y,
    w,
    h,
    minW: 3,
    minH: pinnedSymbol ? 8 : 2,
  }));
}
