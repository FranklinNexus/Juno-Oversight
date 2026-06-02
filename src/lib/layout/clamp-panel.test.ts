import { describe, expect, it } from "vitest";
import { clampPanel } from "@/lib/layout/clamp-panel";

describe("clampPanel", () => {
  it("clamps width and position inside the grid", () => {
    const result = clampPanel({
      i: "panel-test",
      x: 20,
      y: 20,
      w: 99,
      h: 99,
      widgetType: "market",
    });
    expect(result.w).toBe(12);
    expect(result.h).toBe(12);
    expect(result.x).toBe(0);
    expect(result.y).toBe(0);
  });

  it("enforces minimum size", () => {
    const result = clampPanel({
      i: "panel-test",
      x: 0,
      y: 0,
      w: 1,
      h: 1,
      widgetType: "github",
    });
    expect(result.w).toBe(3);
    expect(result.h).toBe(2);
  });
});
