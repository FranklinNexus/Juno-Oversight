"use client";

import { WidgetShell } from "@/components/dashboard/WidgetShell";
import { HudButton, MetricRow } from "@/components/ui";
import { useSchedulerStatus } from "@/hooks/useSchedulerStatus";

export function OverseerDaemonPanel() {
  const { status, tauriReady, busy, start, stop } = useSchedulerStatus();
  const live = status.running;

  return (
    <div className="h-full min-h-0">
      <WidgetShell title="24/7 Scheduler" code="WIDGET-S" live={live}>
        <div className="h-full p-2 flex flex-col gap-2 min-h-0">
          <div className="flex gap-1">
            <HudButton disabled={!tauriReady || busy || live} onClick={start}>
              Start Daemon
            </HudButton>
            <HudButton variant="danger" disabled={!tauriReady || busy || !live} onClick={stop}>
              Stop
            </HudButton>
          </div>

          {!tauriReady && (
            <p className="text-[10px] text-[var(--text-muted)]">需要 Tauri 桌面壳。</p>
          )}

          <MetricRow
            label="Daemon"
            value={status.running ? `RUNNING · pid ${status.pid ?? "?"}` : "STOPPED"}
            alert={!status.running}
          />
          <MetricRow label="Runs today" value={String(status.runsToday)} />
          <MetricRow label="Last action" value={status.lastAction ?? "—"} />
          <MetricRow label="Last tick" value={status.lastTickAt ?? "—"} />

          <div className="flex-1 min-h-0 text-[10px] text-[var(--text-muted)] font-mono overflow-auto">
            长任务模式：每 slot ≤25min → checkpoint → 自动续跑（maxRetries=3）。
            Daemon 从 queue/now.yaml 取任务，events.jsonl 流式写入。
          </div>
        </div>
      </WidgetShell>
    </div>
  );
}
