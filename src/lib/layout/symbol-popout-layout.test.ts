import { describe, expect, it } from "vitest";
import {
  dedupePinnedSymbolPanels,
  findSymbolPopoutPosition,
  SYMBOL_POPOUT_SIZE,
} from "@/lib/layout/symbol-popout-layout";
import type { PanelState } from "@/lib/layout/types";

describe("findSymbolPopoutPosition", () => {
  it("opens on the right side", () => {
    const pos = findSymbolPopoutPosition([], SYMBOL_POPOUT_SIZE);
    expect(pos.x).toBeGreaterThanOrEqual(7);
  });

  it("dedupes duplicate pinned symbol panels", () => {
    const panels: PanelState[] = [
      {
        i: "a",
        x: 7,
        y: 1,
        w: 5,
        h: 14,
        widgetType: "market",
        contentZoom: 1,
        pinnedSymbol: "ETH-USDT",
        stackOrder: 1,
      },
      {
        i: "b",
        x: 6,
        y: 2,
        w: 5,
        h: 14,
        widgetType: "market",
        contentZoom: 1,
        pinnedSymbol: "ETH-USDT",
        stackOrder: 3,
      },
    ];
    const next = dedupePinnedSymbolPanels(panels);
    expect(next).toHaveLength(1);
    expect(next[0]?.i).toBe("b");
  });

  it("dedupes duplicate pinned symbol panels", () => {
    const panels: PanelState[] = [
      {
        i: "a",
        x: 7,
        y: 1,
        w: 5,
        h: 14,
        widgetType: "market",
        contentZoom: 1,
        pinnedSymbol: "ETH-USDT",
        stackOrder: 1,
      },
      {
        i: "b",
        x: 6,
        y: 2,
        w: 5,
        h: 14,
        widgetType: "market",
        contentZoom: 1,
        pinnedSymbol: "ETH-USDT",
        stackOrder: 3,
      },
    ];
    const next = dedupePinnedSymbolPanels(panels);
    expect(next).toHaveLength(1);
    expect(next[0]?.i).toBe("b");
  });

  it("cascades stacked symbol panels", () => {
    const pinned = {
      x: 7,
      y: 1,
      w: 5,
      h: 14,
      pinnedSymbol: "ETH-USDT",
    };
    const next = findSymbolPopoutPosition([pinned], SYMBOL_POPOUT_SIZE);
    expect(next.x !== pinned.x || next.y !== pinned.y).toBe(true);
  });
});
