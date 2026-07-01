"use client";

import { WidgetShell } from "@/components/dashboard/WidgetShell";
import { EmptyState, HudButton, LoadingRows } from "@/components/ui";
import { usePromotePanel } from "@/hooks/usePromotePanel";

export function PromotePanel() {
  const { staging, rules, loading, busy, message, tauriReady, promote } = usePromotePanel();
  const defaultRule = rules[0]?.id ?? "jinstone-devlog";

  return (
    <div className="h-full min-h-0">
      <WidgetShell title="Promote" code="WIDGET-P">
        <div className="h-full p-2 flex flex-col gap-2 min-h-0">
          {!tauriReady && (
            <p className="text-[10px] text-[var(--text-muted)]">需要 Tauri 才能 Promote 到 Vault。</p>
          )}
          {message && (
            <p className="text-[10px] text-[var(--accent-gold)] font-mono break-all">{message}</p>
          )}
          {loading ? (
            <LoadingRows rows={4} className="flex-1" />
          ) : staging.length === 0 ? (
            <EmptyState message="staging/ 为空。" />
          ) : (
            <div className="flex-1 min-h-0 overflow-auto space-y-1">
              {staging.map((entry) => (
                <div
                  key={entry.relativePath}
                  className="border border-[var(--border-dim)] px-2 py-1 flex items-center justify-between gap-2 text-[10px] font-mono"
                >
                  <span className="truncate">{entry.relativePath}</span>
                  <HudButton
                    disabled={!tauriReady || busy}
                    onClick={() => promote(defaultRule, entry.relativePath)}
                  >
                    Promote
                  </HudButton>
                </div>
              ))}
            </div>
          )}
        </div>
      </WidgetShell>
    </div>
  );
}
