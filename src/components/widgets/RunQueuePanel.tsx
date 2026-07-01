"use client";

import { WidgetShell } from "@/components/dashboard/WidgetShell";
import { EmptyState, LoadingRows, MetricRow, TagChip } from "@/components/ui";
import { useWorkbenchSnapshot } from "@/hooks/useWorkbenchSnapshot";

const horizonTone = {
  day: "gold" as const,
  mission: "muted" as const,
};

export function RunQueuePanel() {
  const { loading, queue, rootConfigured, rootPath } = useWorkbenchSnapshot();

  return (
    <div className="h-full min-h-0">
      <WidgetShell title="Run Queue" code="WIDGET-Q" live={queue.some((q) => q.status === "running")}>
        <div className="h-full p-2 flex flex-col gap-2 min-h-0">
          <MetricRow
            label="Workbench"
            value={rootConfigured && rootPath ? "CONFIGURED" : "DEMO / UNCONFIGURED"}
            alert={!rootConfigured}
          />

          {loading ? (
            <LoadingRows rows={4} className="flex-1" />
          ) : queue.length === 0 ? (
            <EmptyState message="queue/now.yaml is empty." />
          ) : (
            <div className="flex-1 min-h-0 overflow-auto space-y-1">
              {queue.map((item) => (
                <div
                  key={item.id}
                  className="border border-[var(--border-dim)] px-2 py-1.5 text-xs font-mono-numeric"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate">{item.id}</span>
                    <TagChip tone={horizonTone[item.horizon]}>{item.horizon}</TagChip>
                  </div>
                  <div className="text-[10px] text-[var(--text-muted)] mt-1 truncate">
                    {item.kind} · {item.prompt}
                    {item.mission_id ? ` · ${item.mission_id}/${item.phase_id}` : ""}
                  </div>
                  <div className="text-[10px] uppercase tracking-[0.08em] mt-1 text-[var(--text-muted)]">
                    {item.status ?? "queued"} · {item.provider ?? "—"} · {item.max_minutes ?? 25}m
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </WidgetShell>
    </div>
  );
}
