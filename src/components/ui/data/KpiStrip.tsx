import { cn } from "@/lib/cn";
import type { HudSemantic } from "@/lib/design/tokens";
import { semanticClass } from "@/lib/design/tokens";

export type KpiItem = {
  id: string;
  label: string;
  value: string;
  tone?: HudSemantic;
};

type KpiStripProps = {
  items: KpiItem[];
  className?: string;
};

export function KpiStrip({ items, className }: KpiStripProps) {
  return (
    <div
      className={cn(
        "flex items-stretch divide-x divide-[var(--border-dim)] border border-[var(--border-dim)]",
        className,
      )}
    >
      {items.map((item) => (
        <div key={item.id} className="flex-1 min-w-0 px-2 py-1">
          <div className="text-[9px] uppercase tracking-[0.12em] text-[var(--text-muted)] truncate">
            {item.label}
          </div>
          <div
            className={cn(
              "font-mono-numeric text-xs truncate",
              semanticClass[item.tone ?? "default"],
            )}
          >
            {item.value}
          </div>
        </div>
      ))}
    </div>
  );
}
