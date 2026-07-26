"use client";

import { WidgetShell } from "@/components/dashboard/WidgetShell";
import { EmptyState, HudButton, LoadingRows, MetricRow } from "@/components/ui";
import { useRunControl } from "@/hooks/useRunControl";
import { useRunEvents } from "@/hooks/useRunEvents";
import { useWorkbenchSnapshot } from "@/hooks/useWorkbenchSnapshot";

export function ActiveRunPanel() {
  const {
    loading,
    activeRunId,
    activeRunStatus,
    rootConfigured,
    rootPath,
    source,
    error: snapshotError,
    daemons,
    refresh,
  } = useWorkbenchSnapshot();
  const live = activeRunStatus === "running";
  const blockedDaemons = [
    ["JUNO", daemons.juno],
    ["AGI", daemons.agi],
    ["BOOK", daemons.book],
  ] as const;
  const blockedDaemonEntries = blockedDaemons.filter(([, daemon]) =>
    daemon.status.toLowerCase().includes("blocked"),
  );
  const { lines, loading: eventsLoading, tauriReady, refresh: refreshEvents } = useRunEvents(
    activeRunId,
    Boolean(activeRunId),
  );
  const onRunChanged = () => {
    refresh();
    refreshEvents();
  };
  const { busy, error, spawn, kill } = useRunControl(onRunChanged);

  return (
    <div className="h-full min-h-0">
      <WidgetShell title="Active Run" code="WIDGET-R" live={live}>
        <div className="h-full p-2 flex flex-col gap-2 min-h-0">
          <div className="flex flex-wrap gap-1">
            <HudButton
              disabled={!tauriReady || busy || live}
              onClick={() => spawn(true)}
            >
              Spawn Dry
            </HudButton>
            <HudButton
              disabled={!tauriReady || busy || live}
              onClick={() => spawn(false)}
            >
              Spawn Live
            </HudButton>
            <HudButton variant="danger" disabled={!tauriReady || busy || !live} onClick={kill}>
              Kill
            </HudButton>
          </div>

          {!tauriReady && (
            <p className="text-[10px] text-[var(--text-muted)]">
              浏览器 dev 无 Tauri — 用 `pnpm tauri:dev` 测试 Spawn / events tail。
            </p>
          )}

          {error && (
            <p className="text-[10px] text-[var(--down)] font-mono break-all">{error}</p>
          )}

          {snapshotError && (
            <p className="text-[10px] text-[var(--down)] font-mono break-all">
              Runtime snapshot failed: {snapshotError}
            </p>
          )}

          {(activeRunStatus === "blocked" || blockedDaemonEntries.length > 0) && (
            <div className="border border-[var(--accent-gold)] px-2 py-1 text-[9px] text-[var(--accent-gold)] font-mono break-all">
              {activeRunStatus === "blocked" && <p>ACTIVE RUN BLOCKED · inspect events before retry</p>}
              {blockedDaemonEntries.map(([label, daemon]) => (
                <p key={label}>
                  {label} BLOCKED · {daemon.blockedReason ?? daemon.evidenceReason ?? "reason unavailable"}
                </p>
              ))}
            </div>
          )}

          {loading ? (
            <LoadingRows rows={5} className="flex-1" />
          ) : !activeRunId ? (
            <EmptyState message="No active run. 点 Spawn Dry 冒烟后端输出。" />
          ) : (
            <>
              <MetricRow label="Run ID" value={activeRunId} />
              <MetricRow
                label="Status"
                value={activeRunStatus.toUpperCase()}
                alert={
                  activeRunStatus === "stall"
                  || activeRunStatus === "failed"
                  || activeRunStatus === "blocked"
                }
              />
              <div className="flex-1 min-h-0 border border-[var(--border-dim)] p-2 text-[10px] text-[var(--text-muted)] font-mono overflow-auto whitespace-pre-wrap">
                {eventsLoading && lines.length === 0
                  ? "Loading events.jsonl…"
                  : lines.length > 0
                    ? lines.join("\n\n")
                    : "（events.jsonl 为空 — run 启动后会写入）"}
              </div>
            </>
          )}

          {rootConfigured && (
            <p className="text-[9px] text-[var(--text-muted)] truncate">
              workbench: {rootPath} · source={source}
            </p>
          )}
        </div>
      </WidgetShell>
    </div>
  );
}
