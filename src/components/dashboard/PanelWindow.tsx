"use client";

import { useCallback, useEffect } from "react";
import type { PointerEvent, WheelEvent } from "react";
import { HudButton, HudSelect } from "@/components/ui";
import { cn } from "@/lib/cn";
import type { PanelSizePreset } from "@/lib/layout/constants";
import { matchPanelPreset } from "@/lib/layout/panel-preset";
import {
  WIDGET_REGISTRY,
  type WidgetType,
} from "@/lib/layout/widget-registry";
import { useLayoutStore } from "@/store/layout-store";

type PanelWindowProps = {
  panelId: string;
  widgetType: WidgetType;
};

export function PanelWindow({ panelId, widgetType }: PanelWindowProps) {
  const panel = useLayoutStore((state) => state.panels.find((item) => item.i === panelId));
  const setPanelSize = useLayoutStore((state) => state.setPanelSize);
  const bumpPanelGrid = useLayoutStore((state) => state.bumpPanelGrid);
  const bumpPanelContentZoom = useLayoutStore((state) => state.bumpPanelContentZoom);
  const setWidgetType = useLayoutStore((state) => state.setWidgetType);
  const removePanel = useLayoutStore((state) => state.removePanel);
  const toggleMaximize = useLayoutStore((state) => state.toggleMaximize);
  const bringPanelToFront = useLayoutStore((state) => state.bringPanelToFront);
  const focusPanelId = useLayoutStore((state) => state.focusPanelId);
  const clearFocusPanel = useLayoutStore((state) => state.clearFocusPanel);
  const isMaximized = useLayoutStore((state) => Boolean(state.maximizeCache[panelId]));
  const panelCount = useLayoutStore((state) => state.panels.length);

  const definition = WIDGET_REGISTRY.find((item) => item.type === widgetType) ?? WIDGET_REGISTRY[0];
  const WidgetComponent = definition.Component;
  const contentZoom = panel?.contentZoom ?? 1;
  const activePreset = panel ? matchPanelPreset(panel) : null;

  const handleChromeWheel = useCallback(
    (event: WheelEvent<HTMLDivElement>) => {
      event.stopPropagation();

      if (event.shiftKey) {
        event.preventDefault();
        const delta = event.deltaY > 0 ? -1 : 1;
        bumpPanelGrid(panelId, 0, delta);
        return;
      }

      if (event.ctrlKey || event.metaKey) {
        event.preventDefault();
        const delta = event.deltaY > 0 ? -1 : 1;
        bumpPanelGrid(panelId, delta, 0);
        return;
      }

      event.preventDefault();
      bumpPanelContentZoom(panelId, event.deltaY);
    },
    [bumpPanelContentZoom, bumpPanelGrid, panelId],
  );

  const handleChromePointerDown = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) return;
      bringPanelToFront(panelId);
    },
    [bringPanelToFront, panelId],
  );

  useEffect(() => {
    if (focusPanelId !== panelId) return;
    requestAnimationFrame(() => {
      document
        .querySelector(`[data-panel-id="${panelId}"]`)
        ?.scrollIntoView({ block: "nearest", behavior: "smooth" });
      clearFocusPanel();
    });
  }, [clearFocusPanel, focusPanelId, panelId]);

  if (!panel) return null;

  return (
    <div className="panel-window h-full flex flex-col border border-[var(--border-dim)] bg-[var(--bg-panel)] overflow-hidden shadow-none">
      <div
        className={cn(
          "panel-chrome panel-drag-handle select-none h-7 shrink-0 border-b border-[var(--border-dim)] px-1.5 flex items-center gap-1.5 bg-[var(--bg-elevated)] cursor-grab active:cursor-grabbing",
          isMaximized && "ring-1 ring-[var(--accent-gold)]",
          panel.pinnedSymbol && "panel-chrome--symbol",
        )}
        onPointerDown={handleChromePointerDown}
        onWheel={handleChromeWheel}
        onDoubleClick={(event) => {
          if ((event.target as HTMLElement).closest("button, select")) return;
          event.stopPropagation();
          toggleMaximize(panelId);
        }}
        title="按住标题栏拖动 | 滚轮：缩放内容 | Shift+滚轮：高度 | Ctrl+滚轮：宽度"
      >
        <span
          className="text-[10px] text-[var(--text-muted)] tracking-[0.2em] select-none pointer-events-none"
          aria-hidden
        >
          ::
        </span>
        <HudButton onClick={() => toggleMaximize(panelId)}>
          {isMaximized ? "RESTORE" : "MAX"}
        </HudButton>

        {panel.pinnedSymbol ? (
          <span
            className="text-[10px] font-mono-numeric text-[var(--accent-gold)] truncate max-w-[88px]"
            title={panel.pinnedSymbol}
          >
            {panel.pinnedSymbol}
          </span>
        ) : null}

        {panel.pinnedSymbol ? (
          <span
            className="text-[10px] font-mono-numeric text-[var(--accent-gold)] truncate max-w-[88px]"
            title={panel.pinnedSymbol}
          >
            {panel.pinnedSymbol}
          </span>
        ) : null}

        <HudSelect
          value={widgetType}
          onChange={(event) => setWidgetType(panelId, event.target.value as WidgetType)}
          className="max-w-[130px]"
        >
          {WIDGET_REGISTRY.map((item) => (
            <option key={item.type} value={item.type}>
              {item.label}
            </option>
          ))}
        </HudSelect>

        <span className="text-[9px] font-mono-numeric text-[var(--text-muted)] tabular-nums">
          {Math.round(contentZoom * 100)}%
        </span>

        <div className="flex items-center gap-1 ml-auto">
          {(["quarter", "half", "full"] as PanelSizePreset[]).map((preset) => (
            <HudButton
              key={preset}
              active={activePreset === preset}
              onClick={() => setPanelSize(panelId, preset)}
            >
              {preset === "quarter" ? "1/4" : preset === "half" ? "1/2" : "FULL"}
            </HudButton>
          ))}
          <HudButton
            variant="danger"
            disabled={panelCount <= 1}
            onClick={() => removePanel(panelId)}
          >
            DEL
          </HudButton>
        </div>
      </div>

      <div className="flex-1 min-h-0 overflow-hidden">
        <div
          className="panel-content-scaler h-full w-full"
          style={{
            transform: `scale(${contentZoom})`,
            transformOrigin: "top left",
            width: `${100 / contentZoom}%`,
            height: `${100 / contentZoom}%`,
          }}
        >
          <WidgetComponent panelId={panelId} />
        </div>
      </div>
    </div>
  );
}
