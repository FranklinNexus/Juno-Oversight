"use client";

import { HudButton, HudSelect } from "@/components/ui";
import type { PanelSizePreset } from "@/lib/layout/constants";
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
  const setPanelSize = useLayoutStore((state) => state.setPanelSize);
  const setWidgetType = useLayoutStore((state) => state.setWidgetType);
  const removePanel = useLayoutStore((state) => state.removePanel);
  const toggleMaximize = useLayoutStore((state) => state.toggleMaximize);
  const isMaximized = useLayoutStore((state) => Boolean(state.maximizeCache[panelId]));
  const panelCount = useLayoutStore((state) => state.panels.length);

  const definition = WIDGET_REGISTRY.find((item) => item.type === widgetType) ?? WIDGET_REGISTRY[0];
  const WidgetComponent = definition.Component;

  const applySize = (preset: PanelSizePreset) => setPanelSize(panelId, preset);

  return (
    <div className="panel-window h-full flex flex-col border border-[var(--border-dim)] bg-[var(--bg-panel)] overflow-hidden shadow-none">
      <div
        className={`panel-chrome h-7 shrink-0 border-b border-[var(--border-dim)] px-1.5 flex items-center gap-1.5 bg-[var(--bg-elevated)] ${
          isMaximized ? "ring-1 ring-[var(--accent-gold)]" : ""
        }`}
      >
        <span
          className="panel-drag-handle text-[10px] text-[var(--text-muted)] tracking-[0.2em] select-none cursor-grab active:cursor-grabbing"
          onDoubleClick={(event) => {
            event.stopPropagation();
            toggleMaximize(panelId);
          }}
          title="Double-click to maximize / restore"
        >
          ::
        </span>
        <HudButton onClick={() => toggleMaximize(panelId)}>
          {isMaximized ? "RESTORE" : "MAX"}
        </HudButton>

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

        <div className="flex items-center gap-1 ml-auto">
          <HudButton onClick={() => applySize("quarter")}>1/4</HudButton>
          <HudButton onClick={() => applySize("half")}>1/2</HudButton>
          <HudButton onClick={() => applySize("full")}>FULL</HudButton>
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
        <WidgetComponent />
      </div>
    </div>
  );
}
