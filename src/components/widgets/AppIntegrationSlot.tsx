import { WidgetShell } from "@/components/dashboard/WidgetShell";

export function AppIntegrationSlot() {
  return (
    <div style={{ gridArea: "appslot" }}>
      <WidgetShell title="Application Integration Slot" code="WIDGET-D">
        <div className="h-full p-2">
          <div className="h-full border border-dashed border-[var(--border-dim)] flex items-center justify-center text-xs text-[var(--text-muted)]">
            MBT.AI embed slot (Phase 2 iframe)
          </div>
        </div>
      </WidgetShell>
    </div>
  );
}
