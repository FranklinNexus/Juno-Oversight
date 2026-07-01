"use client";

import { WidgetShell } from "@/components/dashboard/WidgetShell";
import { EmptyState, LoadingRows, MetricRow, TagChip } from "@/components/ui";
import { useMissionsSnapshot } from "@/hooks/useMissionsSnapshot";

const phaseTone = (status: string) => {
  if (status === "done") return "gold" as const;
  if (status === "in_progress") return "muted" as const;
  return "muted" as const;
};

export function MissionBoardPanel() {
  const { missions, loading, tauriReady } = useMissionsSnapshot();

  return (
    <div className="h-full min-h-0">
      <WidgetShell
        title="Mission Board"
        code="WIDGET-M"
        live={missions.some((m) => m.status === "ACTIVE")}
      >
        <div className="h-full p-2 flex flex-col gap-2 min-h-0">
          {!tauriReady && (
            <p className="text-[10px] text-[var(--text-muted)]">浏览器 dev 无 Mission 数据。</p>
          )}
          {loading ? (
            <LoadingRows rows={4} className="flex-1" />
          ) : missions.length === 0 ? (
            <EmptyState message="missions/ 为空。见 scaffold landing-site-2026。" />
          ) : (
            <div className="flex-1 min-h-0 overflow-auto space-y-2">
              {missions.map((mission) => (
                <div
                  key={mission.id}
                  className="border border-[var(--border-dim)] px-2 py-1.5 text-xs font-mono-numeric"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate">{mission.title}</span>
                    <TagChip tone="muted">{mission.status}</TagChip>
                  </div>
                  <div className="text-[10px] text-[var(--text-muted)] mt-1">
                    {mission.id} · {mission.provider}
                    {mission.currentPhaseId ? ` · phase ${mission.currentPhaseId}` : ""}
                  </div>
                  <div className="mt-1 flex flex-wrap gap-1">
                    {mission.phases.map((phase) => (
                      <TagChip key={phase.id} tone={phaseTone(phase.status)}>
                        {phase.id}:{phase.status}
                      </TagChip>
                    ))}
                  </div>
                  {mission.progressExcerpt && (
                    <pre className="mt-1 text-[9px] text-[var(--text-muted)] whitespace-pre-wrap max-h-24 overflow-auto">
                      {mission.progressExcerpt}
                    </pre>
                  )}
                </div>
              ))}
            </div>
          )}
          <MetricRow label="Missions" value={String(missions.length)} />
        </div>
      </WidgetShell>
    </div>
  );
}
