"use client";

import { HudThemeToggle } from "@/components/dashboard/HudThemeToggle";
import { LayoutToolbar } from "@/components/dashboard/LayoutToolbar";
import { ConnectionBadge, HudButton, HudSegment } from "@/components/ui";
import { useRuntimeHudMetrics } from "@/hooks/useRuntimeHudMetrics";
import { formatRam } from "@/lib/format";
import { useHudStore, type HudMode } from "@/store/hud-store";
import { useLayoutStore } from "@/store/layout-store";

export function GlobalControlHeader() {
  const mode = useHudStore((state) => state.mode);
  const setMode = useHudStore((state) => state.setMode);
  const wsConnected = useHudStore((state) => state.wsConnected);
  const wsLatencyMs = useHudStore((state) => state.wsLatencyMs);
  const uiScale = useHudStore((state) => state.uiScale);
  const autoFit = useHudStore((state) => state.autoFit);
  const bumpUiScale = useHudStore((state) => state.bumpUiScale);
  const setAutoFit = useHudStore((state) => state.setAutoFit);
  const marketDataMode = useHudStore((state) => state.marketDataMode);
  const toggleMarketDataMode = useHudStore((state) => state.toggleMarketDataMode);
  const addPanel = useLayoutStore((state) => state.addPanel);
  const { cpuPct, ramMb, ramTotalMb, source } = useRuntimeHudMetrics();

  return (
    <header className="h-10 shrink-0 border-b border-[var(--border-dim)] bg-[var(--bg-panel)] px-2 flex items-center justify-between gap-2">
      <div className="flex items-center gap-1">
        <HudSegment<HudMode>
          value={mode}
          onChange={setMode}
          options={[
            { id: "surveillance", label: "Omni-Surveillance" },
            { id: "focus", label: "Deep Focus" },
          ]}
        />
        <HudButton onClick={() => addPanel("runqueue")}>+ Window</HudButton>
        <LayoutToolbar />
      </div>

      <div className="flex items-center gap-2">
        <HudButton
          active={marketDataMode === "live"}
          onClick={toggleMarketDataMode}
          title={marketDataMode === "live" ? "真实行情（Binance + Yahoo）" : "模拟行情"}
        >
          {marketDataMode === "live" ? "LIVE" : "MOCK"}
        </HudButton>
        <div className="flex items-center gap-2">
        <HudButton
          active={marketDataMode === "live"}
          onClick={toggleMarketDataMode}
          title={marketDataMode === "live" ? "真实行情（Binance + Yahoo）" : "模拟行情"}
        >
          {marketDataMode === "live" ? "LIVE" : "MOCK"}
        </HudButton>
        <ConnectionBadge connected={wsConnected} latencyMs={wsLatencyMs} />
      </div>
      </div>

      <div className="font-mono-numeric text-xs flex items-center gap-2">
        <span>
          <span className="text-[var(--text-muted)]">CPU</span> {cpuPct}%
        </span>
        <span>
          <span className="text-[var(--text-muted)]">RAM</span> {formatRam(ramMb)}
          {ramTotalMb != null && (
            <span className="text-[var(--text-muted)]"> / {formatRam(ramTotalMb)}</span>
          )}
        </span>

        <div
          className="flex items-center justify-center border border-[var(--border-dim)] h-6 w-6 shrink-0"
          title="切换主题"
        >
          <HudThemeToggle />
        </div>

        <div className="flex items-center gap-1 border border-[var(--border-dim)] px-1 h-6">
          <HudButton variant="ghost" onClick={() => bumpUiScale(-0.05)} aria-label="Zoom out">
            -
          </HudButton>
          <span className="text-[10px] text-[var(--text-muted)] w-10 text-center">
            {Math.round(uiScale * 100)}%
          </span>
          <HudButton variant="ghost" onClick={() => bumpUiScale(0.05)} aria-label="Zoom in">
            +
          </HudButton>
          <HudButton
            variant="ghost"
            active={autoFit}
            onClick={() => setAutoFit(!autoFit)}
          >
            FIT
          </HudButton>
        </div>

        <span className="text-[10px] text-[var(--text-muted)] uppercase tracking-[0.08em]">
          {source}
        </span>
      </div>
    </header>
  );
}
