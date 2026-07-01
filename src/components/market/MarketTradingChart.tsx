"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  AreaSeries,
  CandlestickSeries,
  ColorType,
  createChart,
  HistogramSeries,
  LineSeries,
  type DeepPartial,
  type IChartApi,
  type ISeriesApi,
  type TimeChartOptions,
  type UTCTimestamp,
} from "lightweight-charts";
import { lastMaValues, macdSeries, emaSeries } from "@/lib/market/indicators";
import { alignChartsToRightEdge } from "@/lib/market/chart-align";
import { generateOhlcSeries, type ChartTimeframe, type OhlcBar } from "@/lib/market/ohlc";
import { useHudStore } from "@/store/hud-store";

export type ChartMode = "candle" | "line";

type MarketTradingChartProps = {
  symbol: string;
  timeframe: ChartTimeframe;
  mode: ChartMode;
  lastPrice: number;
  showLegend?: boolean;
  showMacd?: boolean;
};

type ThemeColors = {
  up: string;
  down: string;
  text: string;
  grid: string;
  bg: string;
  gold: string;
  ma7: string;
  ma25: string;
  ma99: string;
};

function readTheme(): ThemeColors {
  const read = (name: string, fallback: string) => {
    if (typeof document === "undefined") return fallback;
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
  };
  return {
    up: read("--market-up-text", "#e07070"),
    down: read("--market-down-text", "#6fae88"),
    text: read("--text-muted", "#7a808a"),
    grid: read("--border-dim", "#242a33"),
    bg: read("--bg-panel", "#111318"),
    gold: read("--accent-gold", "#c9a227"),
    ma7: read("--accent-gold-bright", "#e0c04a"),
    ma25: "#c9a227",
    ma99: "#9a7b18",
  };
}

function toTime(t: number): UTCTimestamp {
  return t as UTCTimestamp;
}

function baseChartOptions(
  theme: ThemeColors,
  timeframe: ChartTimeframe,
  showTime: boolean,
): DeepPartial<TimeChartOptions> {
  return {
    autoSize: false,
    layout: {
      background: { type: ColorType.Solid, color: theme.bg },
      textColor: theme.text,
      fontFamily: "var(--font-mono), ui-monospace, monospace",
      fontSize: 11,
    },
    grid: {
      vertLines: { color: theme.grid },
      horzLines: { color: theme.grid },
    },
    rightPriceScale: { borderColor: theme.grid },
    timeScale: {
      borderColor: theme.grid,
      visible: showTime,
      timeVisible: true,
      secondsVisible: timeframe === "1m",
      fixRightEdge: true,
      rightOffset: 4,
    },
    crosshair: {
      vertLine: { color: theme.gold, width: 1 as const, labelBackgroundColor: theme.grid },
      horzLine: { color: theme.gold, width: 1 as const, labelBackgroundColor: theme.grid },
    },
  };
}

export function MarketTradingChart({
  symbol,
  timeframe,
  mode,
  lastPrice,
  showLegend = true,
  showMacd = true,
}: MarketTradingChartProps) {
  const marketDataMode = useHudStore((state) => state.marketDataMode);
  const [liveBars, setLiveBars] = useState<OhlcBar[] | null>(null);
  const mainRef = useRef<HTMLDivElement>(null);
  const macdRef = useRef<HTMLDivElement>(null);
  const mainChartRef = useRef<IChartApi | null>(null);
  const macdChartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<{
    candle?: ISeriesApi<"Candlestick">;
    area?: ISeriesApi<"Area">;
    volume?: ISeriesApi<"Histogram">;
    ma7?: ISeriesApi<"Line">;
    ma25?: ISeriesApi<"Line">;
    ma99?: ISeriesApi<"Line">;
    macdHist?: ISeriesApi<"Histogram">;
    macdLine?: ISeriesApi<"Line">;
    signalLine?: ISeriesApi<"Line">;
  }>({});

  useEffect(() => {
    if (marketDataMode !== "live") return;
    let cancelled = false;
    const load = async () => {
      try {
        const res = await fetch(
          `/api/market/klines?symbol=${encodeURIComponent(symbol)}&timeframe=${timeframe}`,
          { cache: "no-store" },
        );
        if (!res.ok) return;
        const json = (await res.json()) as { bars: OhlcBar[] };
        if (!cancelled) setLiveBars(json.bars);
      } catch {
        if (!cancelled) setLiveBars(null);
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [marketDataMode, symbol, timeframe]);

  const mockBars = useMemo(
    () => generateOhlcSeries(symbol, timeframe, lastPrice),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [symbol, timeframe],
  );

  const baseBars =
    marketDataMode === "live" && liveBars && liveBars.length > 0 ? liveBars : mockBars;

  const legend = useMemo(() => lastMaValues(baseBars), [baseBars]);

  useEffect(() => {
    const mainEl = mainRef.current;
    const macdEl = macdRef.current;
    if (!mainEl) return;
    if (showMacd && !macdEl) return;

    const theme = readTheme();
    const mainChart = createChart(mainEl, baseChartOptions(theme, timeframe, false));
    let macdChart: IChartApi | null = null;
    if (showMacd && macdEl) {
      macdChart = createChart(macdEl, {
        ...baseChartOptions(theme, timeframe, true),
        rightPriceScale: { borderColor: theme.grid, scaleMargins: { top: 0.1, bottom: 0.05 } },
      });
    }

    mainChartRef.current = mainChart;
    macdChartRef.current = macdChart;
    seriesRef.current = {};

    if (mode === "candle") {
      seriesRef.current.candle = mainChart.addSeries(CandlestickSeries, {
        upColor: theme.up,
        downColor: theme.down,
        borderUpColor: theme.up,
        borderDownColor: theme.down,
        wickUpColor: theme.up,
        wickDownColor: theme.down,
      });
      seriesRef.current.ma7 = mainChart.addSeries(LineSeries, {
        color: theme.ma7,
        lineWidth: 1,
        priceLineVisible: false,
        lastValueVisible: false,
      });
      seriesRef.current.ma25 = mainChart.addSeries(LineSeries, {
        color: theme.ma25,
        lineWidth: 1,
        priceLineVisible: false,
        lastValueVisible: false,
      });
      seriesRef.current.ma99 = mainChart.addSeries(LineSeries, {
        color: theme.ma99,
        lineWidth: 1,
        priceLineVisible: false,
        lastValueVisible: false,
      });
    } else {
      seriesRef.current.area = mainChart.addSeries(AreaSeries, {
        lineColor: theme.up,
        topColor: `${theme.up}33`,
        bottomColor: `${theme.up}05`,
        lineWidth: 2,
        priceLineVisible: true,
      });
    }

    seriesRef.current.volume = mainChart.addSeries(HistogramSeries, {
      priceFormat: { type: "volume" },
      priceScaleId: "volume",
    });
    mainChart.priceScale("volume").applyOptions({
      scaleMargins: { top: 0.78, bottom: 0 },
    });

    if (macdChart) {
      seriesRef.current.macdHist = macdChart.addSeries(HistogramSeries, {
        priceFormat: { type: "price", precision: 4, minMove: 0.0001 },
      });
      seriesRef.current.macdLine = macdChart.addSeries(LineSeries, {
        color: theme.ma7,
        lineWidth: 1,
        priceLineVisible: false,
        lastValueVisible: false,
      });
      seriesRef.current.signalLine = macdChart.addSeries(LineSeries, {
        color: theme.ma25,
        lineWidth: 1,
        priceLineVisible: false,
        lastValueVisible: false,
      });

      const syncRange = (source: IChartApi, target: IChartApi) => {
        source.timeScale().subscribeVisibleLogicalRangeChange((range) => {
          if (range) target.timeScale().setVisibleLogicalRange(range);
        });
      };
      syncRange(mainChart, macdChart);
      syncRange(macdChart, mainChart);
    }

    const applySize = () => {
      const mw = mainEl.clientWidth;
      const mh = mainEl.clientHeight;
      if (mw > 0 && mh > 0) mainChart.applyOptions({ width: mw, height: mh });
      if (macdChart && macdEl) {
        const cw = macdEl.clientWidth;
        const ch = macdEl.clientHeight;
        if (cw > 0 && ch > 0) macdChart.applyOptions({ width: cw, height: ch });
      }
    };

    applySize();
    const ro = new ResizeObserver(() => applySize());
    ro.observe(mainEl);
    if (showMacd && macdEl) ro.observe(macdEl);

    return () => {
      ro.disconnect();
      mainChart.remove();
      macdChart?.remove();
      mainChartRef.current = null;
      macdChartRef.current = null;
      seriesRef.current = {};
    };
  }, [mode, showMacd, symbol, timeframe]);

  useEffect(() => {
    const s = seriesRef.current;
    const mainChart = mainChartRef.current;
    const macdChart = macdChartRef.current;
    if (!mainChart || !macdChart) return;

    const theme = readTheme();
    const bars: OhlcBar[] = baseBars.map((b, i) =>
      i === baseBars.length - 1
        ? {
            ...b,
            close: lastPrice,
            high: Math.max(b.high, lastPrice),
            low: Math.min(b.low, lastPrice),
          }
        : b,
    );

    if (s.candle) {
      s.candle.setData(
        bars.map((b) => ({
          time: toTime(b.time),
          open: b.open,
          high: b.high,
          low: b.low,
          close: b.close,
        })),
      );
      s.ma7?.setData(emaSeries(bars, 7).map((p) => ({ time: toTime(p.time), value: p.value })));
      s.ma25?.setData(emaSeries(bars, 25).map((p) => ({ time: toTime(p.time), value: p.value })));
      s.ma99?.setData(emaSeries(bars, 99).map((p) => ({ time: toTime(p.time), value: p.value })));
    }

    if (s.area) {
      s.area.setData(bars.map((b) => ({ time: toTime(b.time), value: b.close })));
    }

    s.volume?.setData(
      bars.map((b) => ({
        time: toTime(b.time),
        value: b.volume,
        color: b.close >= b.open ? `${theme.up}44` : `${theme.down}44`,
      })),
    );

    if (showMacd) {
      const macd = macdSeries(bars);
      s.macdHist?.setData(
        macd.map((p) => ({
          time: toTime(p.time),
          value: p.hist,
          color: p.hist >= 0 ? `${theme.up}99` : `${theme.down}99`,
        })),
      );
      s.macdLine?.setData(macd.map((p) => ({ time: toTime(p.time), value: p.macd })));
      s.signalLine?.setData(macd.map((p) => ({ time: toTime(p.time), value: p.signal })));
    }

    const main = mainChartRef.current;
    const macd = macdChartRef.current;
    if (main) alignChartsToRightEdge(main, showMacd ? macd : null);
  }, [baseBars, lastPrice, liveBars, mode, showMacd]);

  useEffect(() => {
    const main = mainChartRef.current;
    if (!main) return;
    alignChartsToRightEdge(main, showMacd ? macdChartRef.current : null);
  }, [symbol, timeframe, mode, showMacd, liveBars]);

  return (
    <div className="h-full min-h-0 flex flex-col">
      {showLegend && (
        <div className="shrink-0 flex flex-wrap gap-3 px-2 py-1 text-[10px] font-mono-numeric border-b border-[var(--border-dim)]">
          <span className="text-[var(--text-muted)]">MA7</span>
          <span style={{ color: "var(--accent-gold-bright)" }}>
            {legend.ma7?.toFixed(2) ?? "—"}
          </span>
          <span className="text-[var(--text-muted)]">MA25</span>
          <span className="text-[var(--accent-gold)]">{legend.ma25?.toFixed(2) ?? "—"}</span>
          <span className="text-[var(--text-muted)]">MA99</span>
          <span className="text-[#9a7b18]">{legend.ma99?.toFixed(2) ?? "—"}</span>
          <span className="ml-auto text-[var(--text-muted)]">
            {showMacd ? "VOL · MACD" : "VOL"}
          </span>
        </div>
      )}
      <div ref={mainRef} className={showMacd ? "flex-[3] min-h-0" : "flex-1 min-h-0"} />
      {showMacd && (
        <>
          <div className="shrink-0 px-2 py-0.5 text-[9px] text-[var(--text-muted)] border-t border-[var(--border-dim)]">
            MACD
          </div>
          <div ref={macdRef} className="shrink-0 h-[88px]" />
        </>
      )}
    </div>
  );
}
