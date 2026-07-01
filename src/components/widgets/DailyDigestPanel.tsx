"use client";

import { WidgetShell } from "@/components/dashboard/WidgetShell";
import { EmptyState, LoadingRows } from "@/components/ui";
import { useWorkbenchSnapshot } from "@/hooks/useWorkbenchSnapshot";

export function DailyDigestPanel() {
  const { loading, dailyExcerpt, dailyTitle, rootConfigured } = useWorkbenchSnapshot();

  return (
    <div className="h-full min-h-0">
      <WidgetShell title="Daily Digest" code="WIDGET-D" live={rootConfigured}>
        <div className="h-full p-2 flex flex-col min-h-0">
          {loading ? (
            <LoadingRows rows={8} className="flex-1" />
          ) : !dailyExcerpt ? (
            <EmptyState message="No daily/YYYY-MM-DD.md yet." />
          ) : (
            <>
              {dailyTitle ? (
                <div className="text-xs text-[var(--text-muted)] mb-2 shrink-0">{dailyTitle}</div>
              ) : null}
              <pre className="flex-1 min-h-0 overflow-auto text-xs whitespace-pre-wrap font-mono leading-relaxed text-[var(--text-primary)]">
                {dailyExcerpt}
              </pre>
            </>
          )}
        </div>
      </WidgetShell>
    </div>
  );
}
