"use client";

import { useCallback, useMemo } from "react";
import type { Layout } from "react-grid-layout";
import { useContainerWidth } from "react-grid-layout";
import { ReactGridLayout } from "react-grid-layout/legacy";
import { PanelWindow } from "@/components/dashboard/PanelWindow";
import { GRID_COLS, GRID_ROW_HEIGHT } from "@/lib/layout/constants";
import { useHudStore } from "@/store/hud-store";
import { panelsToGridLayout, useLayoutStore } from "@/store/layout-store";

export function LayoutCanvas() {
  const panels = useLayoutStore((state) => state.panels);
  const maximizedPanelId = useLayoutStore(
    (state) => Object.keys(state.maximizeCache)[0] ?? null,
  );
  const syncLayout = useLayoutStore((state) => state.syncLayout);
  const uiScale = useHudStore((state) => state.uiScale);
  const { width, containerRef, mounted } = useContainerWidth();

  const visiblePanels = useMemo(() => {
    if (!maximizedPanelId) return panels;
    return panels.filter((panel) => panel.i === maximizedPanelId);
  }, [panels, maximizedPanelId]);

  const layout = useMemo(() => panelsToGridLayout(visiblePanels), [visiblePanels]);

  const commitLayout = useCallback(
    (next: Layout) => {
      syncLayout(next);
    },
    [syncLayout],
  );

  const gridLocked = maximizedPanelId !== null;

  return (
    <div ref={containerRef} className="layout-canvas flex-1 min-h-0 w-full">
      {mounted && width > 0 && (
        <ReactGridLayout
          width={width}
          layout={layout}
          cols={GRID_COLS}
          rowHeight={GRID_ROW_HEIGHT}
          maxRows={12}
          margin={[2, 2]}
          containerPadding={[2, 2]}
          autoSize={false}
          isBounded
          compactType="vertical"
          onDragStop={commitLayout}
          onResizeStop={commitLayout}
          draggableHandle=".panel-drag-handle"
          isDraggable={!gridLocked}
          isResizable={!gridLocked}
          resizeHandles={["se", "e", "s"]}
          useCSSTransforms
          transformScale={uiScale}
        >
          {visiblePanels.map((panel) => (
            <div key={panel.i}>
              <PanelWindow panelId={panel.i} widgetType={panel.widgetType} />
            </div>
          ))}
        </ReactGridLayout>
      )}
    </div>
  );
}
