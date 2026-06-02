"use client";

import { WidgetShell } from "@/components/dashboard/WidgetShell";
import { useJupiterTelemetry } from "@/hooks/useJupiterTelemetry";

function MetricRow({
  label,
  value,
  alert = false,
}: {
  label: string;
  value: string;
  alert?: boolean;
}) {
  return (
    <div className="flex items-center justify-between border-b border-[var(--border-dim)] py-1">
      <span className="text-[10px] uppercase tracking-[0.12em] text-[var(--text-muted)]">
        {label}
      </span>
      <span
        className={`font-mono-numeric text-xs ${
          alert ? "text-[var(--accent-gold)]" : "text-[var(--text-porcelain)]"
        }`}
      >
        {value}
      </span>
    </div>
  );
}

export function InfraTelemetry() {
  const telemetry = useJupiterTelemetry();

  return (
    <div style={{ gridArea: "infra" }}>
      <WidgetShell title="Infrastructure Telemetry" code="WIDGET-C">
        <div className="h-full p-2 flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <span className="text-xs">{telemetry.node}</span>
            <span className="text-[10px] uppercase tracking-[0.08em] text-[var(--text-muted)]">
              {telemetry.source}
            </span>
          </div>

          <div
            className={`flex-1 border p-2 ${
              telemetry.alert
                ? "border-[var(--accent-gold)]"
                : "border-[var(--border-dim)]"
            }`}
          >
            <MetricRow
              label="SSH"
              value={telemetry.sshConnected ? "CONNECTED" : "DISCONNECTED"}
              alert={!telemetry.sshConnected}
            />
            <MetricRow
              label="Thermal"
              value={`${telemetry.thermalC}C`}
              alert={telemetry.thermalC > 62}
            />
            <MetricRow
              label="NPU"
              value={`${telemetry.npuPct}%`}
              alert={telemetry.npuPct > 85}
            />
            <MetricRow label="Edge Latency" value={`${telemetry.latencyMs}ms`} />
          </div>
        </div>
      </WidgetShell>
    </div>
  );
}
