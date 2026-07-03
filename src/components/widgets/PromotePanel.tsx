"use client";

import { WidgetShell } from "@/components/dashboard/WidgetShell";
import { EmptyState, HudButton, LoadingRows } from "@/components/ui";
import { usePromotePanel } from "@/hooks/usePromotePanel";

export function PromotePanel() {
  const {
    staging,
    loading,
    busy,
    message,
    tauriReady,
    promote,
    selectedPath,
    preview,
    previewText,
    previewLoading,
    promoteLog,
    selectEntry,
    defaultRule,
  } = usePromotePanel();

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
            <>
              <div className="max-h-[35%] min-h-0 overflow-auto space-y-1">
                {staging.map((entry) => {
                  const selected = selectedPath === entry.relativePath;
                  return (
                    <div
                      key={entry.relativePath}
                      className={`border px-2 py-1 flex items-center justify-between gap-2 text-[10px] font-mono cursor-pointer ${
                        selected
                          ? "border-[var(--accent-gold)] bg-[var(--bg-panel)]"
                          : "border-[var(--border-dim)]"
                      }`}
                      onClick={() => selectEntry(entry.relativePath)}
                    >
                      <span className="truncate">{entry.relativePath}</span>
                      <span className="text-[var(--text-muted)] shrink-0">{entry.sizeBytes}b</span>
                    </div>
                  );
                })}
              </div>

              <div className="flex-1 min-h-0 flex flex-col gap-1 border border-[var(--border-dim)] p-2">
                <div className="text-[10px] text-[var(--text-muted)] uppercase tracking-wide">
                  Diff preview {previewLoading ? "· loading…" : preview ? `· ${preview.action}` : ""}
                </div>
                {!selectedPath ? (
                  <p className="text-[10px] text-[var(--text-muted)]">选择 staging 条目以预览 Vault diff。</p>
                ) : previewLoading ? (
                  <LoadingRows rows={3} />
                ) : previewText ? (
                  <pre className="flex-1 min-h-0 overflow-auto text-[10px] font-mono whitespace-pre-wrap break-all text-[var(--text-primary)]">
                    {previewText}
                  </pre>
                ) : (
                  <p className="text-[10px] text-[var(--text-muted)]">预览不可用。</p>
                )}
                <div className="flex gap-1 pt-1">
                  <HudButton
                    disabled={!tauriReady || busy || !selectedPath || previewLoading}
                    onClick={() => selectedPath && promote(defaultRule, selectedPath)}
                  >
                    Promote
                  </HudButton>
                  {preview?.action === "unchanged" && (
                    <span className="text-[10px] text-[var(--text-muted)] self-center">unchanged — 跳过</span>
                  )}
                </div>
              </div>

              {promoteLog.length > 0 && (
                <div className="max-h-[25%] min-h-0 overflow-auto border border-[var(--border-dim)] p-2">
                  <div className="text-[10px] text-[var(--text-muted)] uppercase tracking-wide mb-1">
                    promote.log
                  </div>
                  <pre className="text-[9px] font-mono whitespace-pre-wrap break-all text-[var(--text-muted)]">
                    {promoteLog.join("\n")}
                  </pre>
                </div>
              )}
            </>
          )}
        </div>
      </WidgetShell>
    </div>
  );
}
