"use client";

import { WidgetShell } from "@/components/dashboard/WidgetShell";
import { AlertFrame, LoadingRows, MetricRow } from "@/components/ui";
import { useJupiterTelemetry } from "@/hooks/useJupiterTelemetry";

export function InfraTelemetry() {
  const telemetry = useJupiterTelemetry();

  return (
    <div className="h-full min-h-0">
      <WidgetShell
        title="Infrastructure Telemetry"
        code="WIDGET-C"
        live={telemetry.ready && telemetry.sshConnected}
      >
        <div className="h-full p-2 flex flex-col gap-2 min-h-0">
          <div className="flex items-center justify-between">
            <span className="text-xs">{telemetry.node}</span>
            <span className="text-[10px] uppercase tracking-[0.08em] text-[var(--text-muted)]">
              {telemetry.source}
            </span>
          </div>

          {!telemetry.ready ? (
            <LoadingRows rows={5} className="flex-1" />
          ) : (
            <AlertFrame active={telemetry.alert} className="flex-1 min-h-0">
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
            </AlertFrame>
          )}
        </div>
      </WidgetShell>
    </div>
  );
}
