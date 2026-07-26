"use client";

import { WidgetShell } from "@/components/dashboard/WidgetShell";
import { EmptyState, LoadingRows, MetricRow, TagChip } from "@/components/ui";
import { useWorkbenchSnapshot } from "@/hooks/useWorkbenchSnapshot";

const horizonTone = {
  day: "gold" as const,
  mission: "muted" as const,
};

export function RunQueuePanel() {
  const { loading, queue, rootConfigured, source, error, daemons } =
    useWorkbenchSnapshot();
  const daemonEntries = [
    ["JUNO", daemons.juno],
    ["AGI", daemons.agi],
    ["BOOK", daemons.book],
  ] as const;
  const blockedDaemons = daemonEntries.filter(([, daemon]) =>
    daemon.status.toLowerCase().includes("blocked"),
  );
  const workbenchLabel = error
    ? "READ ERROR"
    : source === "demo"
      ? "DEMO"
      : rootConfigured
        ? "CONFIGURED"
        : source === "tauri"
          ? "UNCONFIGURED"
          : "UNAVAILABLE";

  return (
    <div className="h-full min-h-0">
      <WidgetShell title="Run Queue" code="WIDGET-Q" live={queue.some((q) => q.status === "running")}>
        <div className="h-full p-2 flex flex-col gap-2 min-h-0">
          <MetricRow
            label="Workbench"
            value={workbenchLabel}
            alert={workbenchLabel !== "CONFIGURED"}
          />
          <MetricRow
            label="Runtime source"
            value={source.toUpperCase()}
            alert={source !== "tauri"}
          />

          {error && (
            <p className="text-[10px] text-[var(--down)] font-mono break-all">
              Runtime snapshot failed: {error}
            </p>
          )}

          <div className="grid grid-cols-3 items-start gap-1 border-b border-[var(--border-dim)] pb-1 text-[9px] font-mono-numeric">
            {daemonEntries.map(([label, daemon]) => (
              <span
                key={label}
                className={`min-w-0 text-center [overflow-wrap:anywhere] ${
                  daemon.status.toLowerCase().includes("blocked")
                    ? "text-[var(--accent-gold)]"
                    : "text-[var(--text-muted)]"
                }`}
                title={daemon.blockedReason ?? daemon.lastDetail ?? `${label} daemon`}
              >
                {label} {daemon.status.toUpperCase()}
              </span>
            ))}
          </div>

          {blockedDaemons.map(([label, daemon]) => (
            <p
              key={label}
              className="text-[9px] text-[var(--accent-gold)] font-mono break-all"
            >
              {label} BLOCKED: {daemon.blockedReason ?? daemon.evidenceReason ?? "reason unavailable"}
            </p>
          ))}

          {loading ? (
            <LoadingRows rows={4} className="flex-1" />
          ) : queue.length === 0 ? (
            <EmptyState message="queue/now.yaml is empty." />
          ) : (
            <div className="flex-1 min-h-0 overflow-auto space-y-1">
              {queue.map((item) => (
                <div
                  key={item.id}
                  className="min-w-0 overflow-hidden border border-[var(--border-dim)] px-2 py-1.5 text-xs font-mono-numeric"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="min-w-0 truncate">{item.id}</span>
                    <span className="shrink-0">
                      <TagChip tone={horizonTone[item.horizon]}>{item.horizon}</TagChip>
                    </span>
                  </div>
                  <div className="text-[10px] text-[var(--text-muted)] mt-1 truncate">
                    {item.kind} · {item.prompt}
                    {item.mission_id ? ` · ${item.mission_id}/${item.phase_id}` : ""}
                  </div>
                  <div
                    className={`mt-1 text-[10px] uppercase [overflow-wrap:anywhere] ${
                      item.status === "blocked"
                        ? "text-[var(--accent-gold)]"
                        : "text-[var(--text-muted)]"
                    }`}
                  >
                    {item.status ?? "queued"} · {item.provider ?? "—"} · {item.max_minutes ?? 25}m
                  </div>
                  {item.experiment_id && (
                    <div className="mt-1 text-[9px] text-[var(--text-muted)] [overflow-wrap:anywhere]">
                      EXP {item.experiment_arm} #{item.experiment_episode} · {item.workflow_id}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </WidgetShell>
    </div>
  );
}
