"use client";

import { WidgetShell } from "@/components/dashboard/WidgetShell";
import { EmptyState, KpiStrip, LoadingRows, MetricRow } from "@/components/ui";
import { useWorkflowEffectSnapshot } from "@/hooks/useWorkflowEffectSnapshot";

function rate(value: number | null): string {
  return value == null ? "—" : `${Math.round(value * 100)}%`;
}

export function WorkflowEffectPanel() {
  const { available, latest, loading } = useWorkflowEffectSnapshot();

  return (
    <div className="h-full min-h-0">
      <WidgetShell title="Workflow Effect" code="WIDGET-E" live={available}>
        <div className="h-full min-h-0 p-2 flex flex-col gap-2">
          {loading ? (
            <LoadingRows rows={5} className="flex-1" />
          ) : !available || !latest ? (
            <EmptyState message="暂无已验证工作流结果。" />
          ) : (
            <>
              <KpiStrip
                items={[
                  { id: "done", label: "Delivered", value: String(latest.missionDone), tone: "gold" },
                  {
                    id: "verify",
                    label: "Verify",
                    value: rate(latest.verifyPassRate),
                    tone: latest.verifyPassRate === 1 ? "ok" : "warn",
                  },
                  {
                    id: "rework",
                    label: "Rework",
                    value: rate(latest.reworkRate),
                    tone: latest.reviewRework > 0 ? "warn" : "ok",
                  },
                  {
                    id: "human",
                    label: "Escalated",
                    value: String(latest.escalations),
                    tone: latest.escalations > 0 ? "danger" : "ok",
                  },
                ]}
              />
              <div className="min-h-0 overflow-auto">
                <MetricRow label="Verified slots" value={String(latest.verifyPass)} />
                <MetricRow
                  label="Review revisions"
                  value={String(latest.reviewRework)}
                  tone={latest.reviewRework > 0 ? "warn" : "ok"}
                />
                <MetricRow
                  label="Review blocks"
                  value={String(latest.reviewBlock)}
                  tone={latest.reviewBlock > 0 ? "danger" : "ok"}
                />
                <MetricRow label="Autonomy ticks" value={String(latest.ticks)} />
                <MetricRow label="Strategy" value={latest.strategy || "balanced"} />
              </div>
              <div className="mt-auto text-[9px] text-[var(--text-muted)] font-mono-numeric">
                {latest.date}
              </div>
            </>
          )}
        </div>
      </WidgetShell>
    </div>
  );
}
