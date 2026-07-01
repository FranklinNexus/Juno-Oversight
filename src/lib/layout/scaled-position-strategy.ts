import { setTransform } from "react-grid-layout";
import type { PositionStrategy } from "react-grid-layout/core";

/**
 * Scaled drag without createScaledStrategy's calcDragPosition (viewport-absolute),
 * which jumps by ~header offset on mousedown when a toolbar sits above the grid.
 * DraggableCore still receives strategy.scale; drag start uses parent-relative rects.
 */
export function createHudScaledStrategy(scale: number): PositionStrategy {
  return {
    type: "transform",
    scale,
    calcStyle(pos) {
      return setTransform(pos);
    },
  };
}
