/** Minimum heights (px) for progressive disclosure in symbol pop-out panels. */
export const SYMBOL_DETAIL_LAYOUT = {
  chartMin: 120,
  legend: 26,
  macdBlock: 94,
  bookPanel: 136,
} as const;

export type SymbolDetailTier = "chart" | "indicators" | "full";

export type SymbolDetailLayout = {
  tier: SymbolDetailTier;
  showLegend: boolean;
  showMacd: boolean;
  showOrderBook: boolean;
};

/**
 * Priority when growing the panel (phone-widget style):
 * 1) K线主图 (+ 内嵌成交量)
 * 2) MA 图例 + MACD 子图
 * 3) 订单表 / 深度
 */
export function resolveSymbolDetailLayout(contentHeight: number): SymbolDetailLayout {
  const { chartMin, legend, macdBlock, bookPanel } = SYMBOL_DETAIL_LAYOUT;
  const indicatorsFloor = chartMin + legend + macdBlock;
  const fullFloor = indicatorsFloor + bookPanel;

  if (contentHeight >= fullFloor) {
    return { tier: "full", showLegend: true, showMacd: true, showOrderBook: true };
  }
  if (contentHeight >= indicatorsFloor) {
    return { tier: "indicators", showLegend: true, showMacd: true, showOrderBook: false };
  }
  return {
    tier: "chart",
    showLegend: contentHeight >= chartMin + legend,
    showMacd: false,
    showOrderBook: false,
  };
}
