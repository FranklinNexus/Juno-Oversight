"use client";

import { useEffect, useRef } from "react";
import {
  CandlestickSeries,
  ColorType,
  createChart,
  HistogramSeries,
  type IChartApi,
  type ISeriesApi,
} from "lightweight-charts";
import { generateOhlcSeries, type ChartTimeframe, type OhlcBar } from "@/lib/market/ohlc";

type MarketCandlestickChartProps = {
  symbol: string;
  timeframe: ChartTimeframe;
  lastPrice: number;
};

function readThemeColor(varName: string, fallback: string): string {
  if (typeof document === "undefined") return fallback;
  const value = getComputedStyle(document.documentElement).getPropertyValue(varName).trim();
  return value || fallback;
}

export function MarketCandlestickChart({
  symbol,
  timeframe,
  lastPrice,
}: MarketCandlestickChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const volumeRef = useRef<ISeriesApi<"Histogram"> | null>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const up = readThemeColor("--market-up-text", "#e07070");
    const down = readThemeColor("--market-down-text", "#6fae88");
    const text = readThemeColor("--text-muted", "#7a808a");
    const grid = readThemeColor("--border-dim", "#242a33");
    const bg = readThemeColor("--bg-panel", "#111318");

    const chart = createChart(el, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: bg },
        textColor: text,
        fontFamily: "var(--font-mono), ui-monospace, monospace",
        fontSize: 11,
      },
      grid: {
        vertLines: { color: grid },
        horzLines: { color: grid },
      },
      rightPriceScale: {
        borderColor: grid,
        scaleMargins: { top: 0.08, bottom: 0.22 },
      },
      timeScale: {
        borderColor: grid,
        timeVisible: true,
        secondsVisible: timeframe === "1m",
      },
      crosshair: {
        vertLine: { color: readThemeColor("--accent-gold", "#c9a227"), width: 1 },
        horzLine: { color: readThemeColor("--accent-gold", "#c9a227"), width: 1 },
      },
    });

    const candles = chart.addSeries(CandlestickSeries, {
      upColor: up,
      downColor: down,
      borderUpColor: up,
      borderDownColor: down,
      wickUpColor: up,
      wickDownColor: down,
    });

    const volume = chart.addSeries(HistogramSeries, {
      priceFormat: { type: "volume" },
      priceScaleId: "",
    });
    volume.priceScale().applyOptions({
      scaleMargins: { top: 0.82, bottom: 0 },
    });

    chartRef.current = chart;
    candleRef.current = candles;
    volumeRef.current = volume;

    const observer = new ResizeObserver(() => {
      chart.applyOptions({
        width: el.clientWidth,
        height: el.clientHeight,
      });
    });
    observer.observe(el);

    return () => {
      observer.disconnect();
      chart.remove();
      chartRef.current = null;
      candleRef.current = null;
      volumeRef.current = null;
    };
  }, [timeframe]);

  useEffect(() => {
    const candles = candleRef.current;
    const volume = volumeRef.current;
    if (!candles || !volume) return;

    const bars = generateOhlcSeries(symbol, timeframe, lastPrice);
    candles.setData(
      bars.map((bar) => ({
        time: bar.time as unknown as import("lightweight-charts").UTCTimestamp,
        open: bar.open,
        high: bar.high,
        low: bar.low,
        close: bar.close,
      })),
    );

    const up = readThemeColor("--market-up-text", "#e07070");
    const down = readThemeColor("--market-down-text", "#6fae88");
    volume.setData(
      bars.map((bar: OhlcBar) => ({
        time: bar.time as unknown as import("lightweight-charts").UTCTimestamp,
        value: bar.volume,
        color: bar.close >= bar.open ? `${up}55` : `${down}55`,
      })),
    );

    chartRef.current?.timeScale().fitContent();
  }, [symbol, timeframe, lastPrice]);

  return <div ref={containerRef} className="w-full h-full min-h-[200px]" />;
}
