"use client";

import { HudThemeToggle } from "@/components/dashboard/HudThemeToggle";
import { LayoutToolbar } from "@/components/dashboard/LayoutToolbar";
import { ConnectionBadge, HudButton, HudSegment } from "@/components/ui";
import { useOperatorRecovery } from "@/hooks/useOperatorRecovery";
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
  const openSingletonPanel = useLayoutStore((state) => state.openSingletonPanel);
  const {
    incidents,
    loading: incidentsLoading,
    error: incidentsError,
  } = useOperatorRecovery();
  const { cpuPct, ramMb, ramTotalMb, source } = useRuntimeHudMetrics();

  return (
    <header className="global-control-header min-h-10 shrink-0 border-b border-[var(--border-dim)] bg-[var(--bg-panel)] px-2 flex items-center justify-between gap-2">
      <div className="global-control-header__primary flex min-w-0 items-center gap-1">
        <HudSegment<HudMode>
          className="global-control-header__mode flex min-w-0 flex-wrap gap-1"
          value={mode}
          onChange={setMode}
          options={[
            { id: "surveillance", label: "Omni-Surveillance" },
            { id: "focus", label: "Deep Focus" },
          ]}
        />
        <HudButton onClick={() => addPanel("runqueue")}>+ Window</HudButton>
        <div className="global-control-header__layout-tools">
          <LayoutToolbar />
        </div>
      </div>

      <div className="global-control-header__connection flex items-center gap-2">
        <HudButton
          active={marketDataMode === "live"}
          onClick={toggleMarketDataMode}
          title={marketDataMode === "live" ? "真实行情（Binance + Yahoo）" : "模拟行情"}
        >
          {marketDataMode === "live" ? "LIVE" : "MOCK"}
        </HudButton>
        <HudButton
          variant={incidents.length > 0 || incidentsError ? "danger" : "outline"}
          onClick={() => openSingletonPanel("incidents")}
          aria-label="Open control incident recovery"
          title={
            incidentsError
              ? `Control incident inventory unavailable: ${incidentsError}`
              : `${incidents.length} blocking control incident${incidents.length === 1 ? "" : "s"}`
          }
        >
          {incidentsLoading ? "INC ..." : incidents.length > 0 ? `INC ${incidents.length}` : "HEALTHY"}
        </HudButton>
        <ConnectionBadge connected={wsConnected} latencyMs={wsLatencyMs} />
      </div>

      <div className="global-control-header__metrics font-mono-numeric text-xs flex items-center gap-2">
        <span className="global-control-header__metric">
          <span className="text-[var(--text-muted)]">CPU</span> {cpuPct}%
        </span>
        <span className="global-control-header__metric">
          <span className="text-[var(--text-muted)]">RAM</span> {formatRam(ramMb)}
          {ramTotalMb != null && (
            <span className="global-control-header__ram-total text-[var(--text-muted)]">
              {" "}/ {formatRam(ramTotalMb)}
            </span>
          )}
        </span>

        <div
          className="global-control-header__theme flex items-center justify-center border border-[var(--border-dim)] h-6 w-6 shrink-0"
          title="切换主题"
        >
          <HudThemeToggle />
        </div>

        <div className="global-control-header__scale flex items-center gap-1 border border-[var(--border-dim)] px-1 h-6">
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

        <span className="global-control-header__source text-[10px] text-[var(--text-muted)] uppercase">
          {source}
        </span>
      </div>
    </header>
  );
}
