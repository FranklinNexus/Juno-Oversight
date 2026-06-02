"use client";

import { useRuntimeHudMetrics } from "@/hooks/useRuntimeHudMetrics";
import { useHudStore, type HudMode } from "@/store/hud-store";

function ModeButton({
  active,
  label,
  onClick,
}: {
  active: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`px-2 h-7 text-[10px] tracking-[0.12em] uppercase border ${
        active
          ? "border-[var(--accent-gold)] text-[var(--accent-gold)]"
          : "border-[var(--border-dim)] text-[var(--text-muted)]"
      }`}
    >
      {label}
    </button>
  );
}

export function GlobalControlHeader() {
  const mode = useHudStore((state) => state.mode);
  const setMode = useHudStore((state) => state.setMode);
  const wsConnected = useHudStore((state) => state.wsConnected);
  const wsLatencyMs = useHudStore((state) => state.wsLatencyMs);
  const { cpuPct, ramMb, source } = useRuntimeHudMetrics();

  const onModeChange = (nextMode: HudMode) => setMode(nextMode);

  return (
    <header
      style={{ gridArea: "header" }}
      className="border border-[var(--border-dim)] bg-[var(--bg-panel)] px-2 flex items-center justify-between gap-2"
    >
      <div className="flex items-center gap-1">
        <ModeButton
          active={mode === "surveillance"}
          label="Omni-Surveillance"
          onClick={() => onModeChange("surveillance")}
        />
        <ModeButton
          active={mode === "focus"}
          label="Deep Focus"
          onClick={() => onModeChange("focus")}
        />
      </div>

      <div className="font-mono-numeric text-xs text-[var(--text-porcelain)] flex items-center gap-2">
        <span
          className={`inline-block size-2 rounded-full ${
            wsConnected ? "bg-[var(--status-ok)]" : "bg-[var(--status-warn)]"
          }`}
        />
        <span>{wsConnected ? "WS" : "DISCONNECTED"}</span>
        <span className="text-[var(--text-muted)]">LAT</span>
        <span>{wsLatencyMs}ms</span>
      </div>

      <div className="font-mono-numeric text-xs flex items-center gap-3">
        <span>
          <span className="text-[var(--text-muted)]">CPU</span> {cpuPct}%
        </span>
        <span>
          <span className="text-[var(--text-muted)]">RAM</span> {ramMb}MB
        </span>
        <span className="text-[10px] text-[var(--text-muted)] uppercase tracking-[0.08em]">
          {source}
        </span>
      </div>
    </header>
  );
}
