"use client";

import { createPortal } from "react-dom";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
} from "react";
import { WidgetShell } from "@/components/dashboard/WidgetShell";
import { EmptyState, HudButton, LoadingRows } from "@/components/ui";
import { useOperatorRecovery } from "@/hooks/useOperatorRecovery";
import type { RecoveryIncident } from "@/lib/workbench/types";
import { applyOperatorRecovery } from "@/lib/workbench/orchestrator-client";

function shortHash(value: string | null): string {
  if (!value) return "n/a";
  return `${value.slice(0, 10)}...${value.slice(-8)}`;
}

function incidentTone(incident: RecoveryIncident): string {
  if (incident.confidence === "invalid") return "text-[var(--down)]";
  if (incident.allowedActions.length === 0) return "text-[var(--status-warn)]";
  return "text-[var(--accent-gold)]";
}

type ConfirmDialogProps = {
  incident: RecoveryIncident;
  busy: boolean;
  onCancel: () => void;
  onApply: (reason: string) => void;
};

function ConfirmRecoveryDialog({ incident, busy, onCancel, onApply }: ConfirmDialogProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const reasonRef = useRef<HTMLInputElement>(null);
  const [reason, setReason] = useState("");
  const [acknowledged, setAcknowledged] = useState(false);

  useEffect(() => {
    reasonRef.current?.focus();
  }, []);

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape" && !busy) {
      event.preventDefault();
      onCancel();
      return;
    }
    if (event.key !== "Tab") return;
    const focusable = Array.from(
      dialogRef.current?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ) ?? [],
    );
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  const trimmedReason = reason.trim();

  return (
    <div className="operator-recovery-backdrop" role="presentation">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="operator-recovery-title"
        aria-describedby="operator-recovery-description"
        className="operator-recovery-dialog"
        onKeyDown={handleKeyDown}
      >
        <header className="border-b border-[var(--border-dim)] px-3 py-2">
          <p className="text-[9px] uppercase text-[var(--accent-gold)]">Fail-closed recovery</p>
          <h2 id="operator-recovery-title" className="text-xs">确认精确恢复</h2>
        </header>

        <div className="space-y-3 p-3 text-[10px]">
          <p id="operator-recovery-description" className="text-[var(--text-muted)]">
            仅恢复这条已验证的 completion intent。提交前会重验完整 inventory；任何漂移都会拒绝执行。
          </p>
          <dl className="grid grid-cols-[86px_minmax(0,1fr)] gap-x-2 gap-y-1 font-mono-numeric">
            <dt className="text-[var(--text-muted)]">Mission</dt>
            <dd className="break-all">{incident.completionBinding?.missionId ?? "n/a"}</dd>
            <dt className="text-[var(--text-muted)]">Intent</dt>
            <dd className="break-all">{incident.artifact.relativePath}</dd>
            <dt className="text-[var(--text-muted)]">Precondition</dt>
            <dd className="break-all">{incident.preconditionSha256}</dd>
          </dl>

          <label className="block">
            <span className="mb-1 block text-[var(--text-muted)]">操作原因</span>
            <input
              ref={reasonRef}
              value={reason}
              maxLength={500}
              disabled={busy}
              onChange={(event) => setReason(event.target.value)}
              className="h-8 w-full border border-[var(--border-dim)] bg-[var(--bg-base)] px-2 text-[11px] outline-none focus:border-[var(--accent-gold)]"
            />
          </label>

          <label className="flex items-start gap-2 text-[var(--text-muted)]">
            <input
              type="checkbox"
              checked={acknowledged}
              disabled={busy}
              onChange={(event) => setAcknowledged(event.target.checked)}
              className="mt-0.5"
            />
            <span>我确认只执行已签发的 resume_exact_intent 动作。</span>
          </label>
        </div>

        <footer className="flex justify-end gap-2 border-t border-[var(--border-dim)] px-3 py-2">
          <HudButton disabled={busy} onClick={onCancel}>Cancel</HudButton>
          <HudButton
            variant="danger"
            disabled={busy || !acknowledged || trimmedReason.length === 0}
            onClick={() => onApply(trimmedReason)}
          >
            {busy ? "Reconciling" : "Resume intent"}
          </HudButton>
        </footer>
      </div>
    </div>
  );
}

export function IncidentRecoveryPanel() {
  const {
    incidents,
    inventorySha256,
    observedAt,
    loading,
    error,
    tauriReady,
    refresh,
  } = useOperatorRecovery();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<RecoveryIncident | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);

  const selected = useMemo(
    () =>
      incidents.find((incident) => incident.incidentId === selectedId) ??
      incidents[0] ??
      null,
    [incidents, selectedId],
  );

  const closeDialog = useCallback(() => {
    setConfirming(null);
    window.requestAnimationFrame(() => triggerRef.current?.focus());
  }, []);

  const openDialog = (event: MouseEvent<HTMLButtonElement>, incident: RecoveryIncident) => {
    triggerRef.current = event.currentTarget;
    setMessage(null);
    setConfirming(incident);
  };

  const executeRecovery = async (reason: string) => {
    if (!confirming) return;
    if (!tauriReady) {
      setMessage("Browser demo does not execute recovery. Open the signed Tauri desktop runtime.");
      closeDialog();
      return;
    }
    setBusy(true);
    setMessage(null);
    try {
      const result = await applyOperatorRecovery({
        incidentId: confirming.incidentId,
        action: "resume_exact_intent",
        preconditionSha256: confirming.preconditionSha256,
        reason,
      });
      const recovered = result.recovery.recovered.length;
      setMessage(
        result.recovery.status === "recovered"
          ? `Recovered ${recovered} exact completion intent${recovered === 1 ? "" : "s"}. OP ${shortHash(result.operationId)}`
          : `${result.recovery.status}: ${result.recovery.reason ?? "no state changed"} · OP ${shortHash(result.operationId)}`,
      );
      closeDialog();
      refresh();
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : String(cause));
      closeDialog();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="h-full min-h-0">
      <WidgetShell
        title="Control Incidents"
        code="WIDGET-I"
        live={!loading && !error}
        actions={<HudButton disabled={loading || busy} onClick={refresh}>Refresh</HudButton>}
      >
        <div className="flex h-full min-h-0 flex-col">
          <div className="flex shrink-0 items-center justify-between gap-2 border-b border-[var(--border-dim)] px-2 py-1 text-[9px] font-mono-numeric">
            <span className={incidents.length > 0 ? "text-[var(--down)]" : "text-[var(--status-ok)]"}>
              {incidents.length > 0 ? `${incidents.length} BLOCKING` : "HEALTHY"}
            </span>
            <span className="truncate text-[var(--text-muted)]" title={inventorySha256}>
              INV {shortHash(inventorySha256)}
            </span>
          </div>

          {error && (
            <p className="shrink-0 border-b border-[var(--border-dim)] px-2 py-1 text-[9px] text-[var(--down)] break-all">
              {error}
            </p>
          )}
          {message && (
            <p aria-live="polite" className="shrink-0 border-b border-[var(--border-dim)] px-2 py-1 text-[9px] text-[var(--accent-gold)] break-all">
              {message}
            </p>
          )}

          {loading && incidents.length === 0 ? (
            <LoadingRows rows={5} className="m-2 flex-1" />
          ) : incidents.length === 0 ? (
            <EmptyState message="No control-plane recovery state detected." />
          ) : (
            <div className="incident-recovery-layout flex-1 min-h-0">
              <div className="incident-recovery-list min-h-0 overflow-auto border-r border-[var(--border-dim)]">
                {incidents.map((incident) => (
                  <button
                    type="button"
                    key={incident.incidentId}
                    aria-pressed={selected?.incidentId === incident.incidentId}
                    onClick={() => setSelectedId(incident.incidentId)}
                    className={`block w-full border-b px-2 py-2 text-left transition-colors ${
                      selected?.incidentId === incident.incidentId
                        ? "border-[var(--accent-gold)] bg-[var(--bg-elevated)]"
                        : "border-[var(--border-dim)] hover:bg-[var(--bg-elevated)]"
                    }`}
                  >
                    <span className={`block text-[9px] uppercase ${incidentTone(incident)}`}>
                      {incident.domain.replace("_", " ")} / {incident.confidence}
                    </span>
                    <span className="mt-0.5 block truncate text-[10px]" title={incident.kind}>
                      {incident.kind.replaceAll("_", " ")}
                    </span>
                    <span className="mt-0.5 block truncate text-[9px] text-[var(--text-muted)]">
                      {incident.artifact.relativePath}
                    </span>
                  </button>
                ))}
              </div>

              <div className="incident-recovery-detail min-h-0 overflow-auto p-2">
                {selected && (
                  <div className="space-y-2 text-[10px]">
                    <div>
                      <p className={`text-[9px] uppercase ${incidentTone(selected)}`}>
                        {selected.allowedActions.length > 0 ? "PROVEN RECOVERY" : "MANUAL FORENSICS REQUIRED"}
                      </p>
                      <h3 className="text-[11px] break-all">{selected.kind.replaceAll("_", " ")}</h3>
                    </div>
                    <p className="text-[var(--text-muted)] break-words">{selected.detail}</p>
                    <dl className="grid grid-cols-[72px_minmax(0,1fr)] gap-x-2 gap-y-1 font-mono-numeric text-[9px]">
                      <dt className="text-[var(--text-muted)]">Artifact</dt>
                      <dd className="break-all">{selected.artifact.relativePath}</dd>
                      <dt className="text-[var(--text-muted)]">Bytes</dt>
                      <dd>{selected.artifact.byteLength ?? "n/a"}</dd>
                      <dt className="text-[var(--text-muted)]">SHA-256</dt>
                      <dd className="break-all">{selected.artifact.sha256 ?? "n/a"}</dd>
                      <dt className="text-[var(--text-muted)]">Observed</dt>
                      <dd className="break-all">{observedAt}</dd>
                    </dl>
                    {selected.allowedActions.includes("resume_exact_intent") ? (
                      <HudButton
                        variant="danger"
                        disabled={busy}
                        onClick={(event) => openDialog(event, selected)}
                      >
                        Review recovery
                      </HudButton>
                    ) : (
                      <p className="border-l-2 border-[var(--status-warn)] pl-2 text-[var(--status-warn)]">
                        No automatic action is authorized for this state.
                      </p>
                    )}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </WidgetShell>

      {confirming && typeof document !== "undefined"
        ? createPortal(
            <ConfirmRecoveryDialog
              incident={confirming}
              busy={busy}
              onCancel={closeDialog}
              onApply={executeRecovery}
            />,
            document.body,
          )
        : null}
    </div>
  );
}
