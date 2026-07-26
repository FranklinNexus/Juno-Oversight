"use client";

import { useCallback, useEffect, useMemo } from "react";
import { GridLayout, useContainerWidth, type Layout, type LayoutItem } from "react-grid-layout";
import {
  containerBounds,
  defaultConstraints,
  getCompactor,
} from "react-grid-layout/core";
import { PanelWindow } from "@/components/dashboard/PanelWindow";
import { GRID_COLS, GRID_MAX_ROWS, GRID_ROW_HEIGHT } from "@/lib/layout/constants";
import {
  beginGridInteraction,
  endGridInteraction,
  resetGridInteraction,
} from "@/lib/layout/grid-interaction";
import { createHudScaledStrategy } from "@/lib/layout/scaled-position-strategy";
import { panelsToGridLayout, useLayoutStore } from "@/store/layout-store";
import { useHudStore } from "@/store/hud-store";

const GRID_MARGIN: [number, number] = [2, 2];
const GRID_PADDING: [number, number] = [2, 2];
const NARROW_SCREEN_BREAKPOINT_PX = 720;
const NARROW_PANEL_MIN_ROWS = 6;

function stackLayout(layout: Layout): Layout {
  let nextY = 0;

  return layout.map((item) => {
    const height = Math.max(NARROW_PANEL_MIN_ROWS, item.h, item.minH ?? 0);
    const stacked = {
      ...item,
      x: 0,
      y: nextY,
      w: GRID_COLS,
      h: height,
      minW: GRID_COLS,
      maxW: GRID_COLS,
    };
    nextY += height;
    return stacked;
  });
}

export function LayoutCanvas() {
  const panels = useLayoutStore((state) => state.panels);
  const maximizedPanelId = useLayoutStore(
    (state) => Object.keys(state.maximizeCache)[0] ?? null,
  );
  const syncLayout = useLayoutStore((state) => state.syncLayout);
  const bringPanelToFront = useLayoutStore((state) => state.bringPanelToFront);
  const sizeAnimPanelId = useLayoutStore((state) => state.sizeAnimPanelId);
  const uiScale = useHudStore((state) => state.uiScale);
  const { width, containerRef, mounted } = useContainerWidth();

  const visiblePanels = useMemo(() => {
    const list = maximizedPanelId
      ? panels.filter((panel) => panel.i === maximizedPanelId)
      : panels;
    return [...list].sort((a, b) => (a.stackOrder ?? 0) - (b.stackOrder ?? 0));
  }, [panels, maximizedPanelId]);

  const desktopLayout = useMemo(() => panelsToGridLayout(visiblePanels), [visiblePanels]);
  const narrowScreen = mounted && width * uiScale < NARROW_SCREEN_BREAKPOINT_PX;
  const layout = useMemo(
    () => (narrowScreen ? stackLayout(desktopLayout) : desktopLayout),
    [desktopLayout, narrowScreen],
  );
  const layoutMaxRows = useMemo(
    () => Math.max(GRID_MAX_ROWS, ...layout.map((item) => item.y + item.h)),
    [layout],
  );

  const commitLayout = useCallback(
    (next: Layout) => {
      syncLayout(next);
    },
    [syncLayout],
  );

  useEffect(() => () => resetGridInteraction(), []);

  const handleDragStart = useCallback(
    (_layout: Layout, _old: LayoutItem | null, item: LayoutItem | null) => {
      beginGridInteraction();
      if (item?.i) bringPanelToFront(item.i);
    },
    [bringPanelToFront],
  );

  const handleDragStop = useCallback(
    (next: Layout) => {
      endGridInteraction();
      commitLayout(next);
    },
    [commitLayout],
  );

  const handleResizeStart = useCallback(() => {
    beginGridInteraction();
  }, []);

  const handleResizeStop = useCallback(
    (next: Layout) => {
      endGridInteraction();
      commitLayout(next);
    },
    [commitLayout],
  );

  const gridLocked = maximizedPanelId !== null || narrowScreen;

  const gridConfig = useMemo(
    () => ({
      cols: GRID_COLS,
      rowHeight: GRID_ROW_HEIGHT,
      maxRows: layoutMaxRows,
      margin: GRID_MARGIN,
      containerPadding: GRID_PADDING,
    }),
    [layoutMaxRows],
  );

  const dragConfig = useMemo(
    () => ({
      enabled: !gridLocked,
      bounded: true,
      handle: ".panel-chrome",
      cancel: "button, select, option, input, textarea, a, [data-no-drag]",
      threshold: 3,
    }),
    [gridLocked],
  );

  const resizeConfig = useMemo(
    () => ({
      enabled: !gridLocked,
      handles: ["se", "e", "s"] as const,
    }),
    [gridLocked],
  );

  const positionStrategy = useMemo(() => createHudScaledStrategy(uiScale), [uiScale]);
  const compactor = useMemo(() => getCompactor(null, true, false), []);
  const constraints = useMemo(() => [...defaultConstraints, containerBounds], []);

  return (
    <div
      ref={containerRef}
      className={`layout-canvas flex-1 min-h-0 w-full${narrowScreen ? " layout-canvas--stacked" : ""}`}
      data-layout-mode={narrowScreen ? "stacked" : "grid"}
    >
      {mounted && width > 0 && (
        <GridLayout
          width={width}
          layout={layout}
          gridConfig={gridConfig}
          dragConfig={dragConfig}
          resizeConfig={resizeConfig}
          positionStrategy={positionStrategy}
          compactor={compactor}
          constraints={constraints}
          autoSize
          onDragStart={handleDragStart}
          onDragStop={handleDragStop}
          onResizeStart={handleResizeStart}
          onResizeStop={handleResizeStop}
        >
          {visiblePanels.map((panel) => (
            <div
              key={panel.i}
              data-panel-id={panel.i}
              className={sizeAnimPanelId === panel.i ? "panel-grid-item--size-anim" : undefined}
              style={{ zIndex: panel.stackOrder ?? 0 }}
            >
              <PanelWindow panelId={panel.i} widgetType={panel.widgetType} />
            </div>
          ))}
        </GridLayout>
      )}
    </div>
  );
}
