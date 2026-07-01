import { describe, expect, it } from "vitest";
import { bumpPanelZoom, clampPanelZoom } from "@/lib/layout/panel-zoom";

describe("panel-zoom", () => {
  it("clamps zoom to 75%–150%", () => {
    expect(clampPanelZoom(0.5)).toBe(0.75);
    expect(clampPanelZoom(2)).toBe(1.5);
  });

  it("bumps zoom in 5% steps from wheel direction", () => {
    expect(bumpPanelZoom(1, -100)).toBe(1.05);
    expect(bumpPanelZoom(1, 100)).toBe(0.95);
  });
});
