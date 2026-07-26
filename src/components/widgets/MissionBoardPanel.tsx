"use client";

import { WidgetShell } from "@/components/dashboard/WidgetShell";
import { EmptyState, LoadingRows, MetricRow, TagChip } from "@/components/ui";
import { useMissionsSnapshot } from "@/hooks/useMissionsSnapshot";

const phaseTone = (status: string) => {
  if (status === "done") return "gold" as const;
  if (status === "in_progress") return "muted" as const;
  return "muted" as const;
};

const missionTone = (status: string) => {
  if (status === "BLOCKED" || status === "UNVERIFIED_COMPLETE") return "down" as const;
  if (status === "ACTIVE") return "gold" as const;
  return "muted" as const;
};

export function MissionBoardPanel() {
  const { missions, loading, tauriReady, error } = useMissionsSnapshot();

  return (
    <div className="h-full min-h-0">
      <WidgetShell
        title="Mission Board"
        code="WIDGET-M"
        live={missions.some((m) => m.status === "ACTIVE")}
      >
        <div className="h-full p-2 flex flex-col gap-2 min-h-0">
          {!tauriReady && !loading && (
            <p className="text-[10px] text-[var(--text-muted)]">浏览器 dev 无 Mission 数据。</p>
          )}
          {error && (
            <p className="text-[10px] text-[var(--down)] font-mono break-all">
              Mission snapshot failed: {error}
            </p>
          )}
          {loading ? (
            <LoadingRows rows={4} className="flex-1" />
          ) : !tauriReady ? (
            <EmptyState message="Mission 数据仅在 Tauri runtime 中可用。" />
          ) : missions.length === 0 ? (
            <EmptyState message="missions/ 为空。见 scaffold landing-site-2026。" />
          ) : (
            <div className="flex-1 min-h-0 overflow-auto space-y-2">
              {missions.map((mission) => (
                <div
                  key={mission.id}
                  className="min-w-0 overflow-hidden border border-[var(--border-dim)] px-2 py-1.5 text-xs font-mono-numeric"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="min-w-0 truncate">{mission.title}</span>
                    <span className="block max-w-[48%] shrink-0 truncate">
                      <TagChip tone={missionTone(mission.status)}>{mission.status}</TagChip>
                    </span>
                  </div>
                  <div className="mt-1 text-[10px] text-[var(--text-muted)] [overflow-wrap:anywhere]">
                    {mission.id} · {mission.provider}
                    {mission.currentPhaseId ? ` · phase ${mission.currentPhaseId}` : ""}
                  </div>
                  <div className="mt-1 flex flex-wrap gap-1">
                    {mission.phases.map((phase) => (
                      <span key={phase.id} className="max-w-full break-all">
                        <TagChip tone={phaseTone(phase.status)}>
                          {phase.id}:{phase.status}
                        </TagChip>
                      </span>
                    ))}
                  </div>
                  {mission.blockedReason && (
                    <p className="mt-1 text-[9px] text-[var(--accent-gold)] break-all">
                      BLOCKED: {mission.blockedReason}
                    </p>
                  )}
                  {mission.progressExcerpt && (
                    <pre className="mt-1 max-h-24 overflow-auto whitespace-pre-wrap text-[9px] text-[var(--text-muted)] [overflow-wrap:anywhere]">
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
