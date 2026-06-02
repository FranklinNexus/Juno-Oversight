import { cn } from "@/lib/cn";
import type { HudSemantic } from "@/lib/design/tokens";
import { semanticClass } from "@/lib/design/tokens";

type MetricRowProps = {
  label: string;
  value: string;
  alert?: boolean;
  tone?: HudSemantic;
};

export function MetricRow({ label, value, alert = false, tone = "default" }: MetricRowProps) {
  return (
    <div className="flex items-center justify-between border-b border-[var(--border-dim)] py-1">
      <span className="text-[10px] uppercase tracking-[0.12em] text-[var(--text-muted)]">
        {label}
      </span>
      <span
        className={cn(
          "font-mono-numeric text-[11px]",
          alert ? "text-[var(--accent-gold)]" : semanticClass[tone],
        )}
      >
        {value}
      </span>
    </div>
  );
}
