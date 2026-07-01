import type { IChartApi } from "lightweight-charts";

const DEFAULT_RIGHT_OFFSET = 4;

/** Pin the latest bar to the right edge (OKX-style). */
export function alignChartsToRightEdge(
  mainChart: IChartApi,
  macdChart?: IChartApi | null,
) {
  const opts = { fixRightEdge: true, rightOffset: DEFAULT_RIGHT_OFFSET };
  mainChart.timeScale().applyOptions(opts);
  macdChart?.timeScale().applyOptions(opts);

  requestAnimationFrame(() => {
    mainChart.timeScale().scrollToRealTime();
    macdChart?.timeScale().scrollToRealTime();
  });
}
