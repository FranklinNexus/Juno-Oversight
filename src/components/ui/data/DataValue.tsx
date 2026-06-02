import { cn } from "@/lib/cn";
import type { HudSemantic } from "@/lib/design/tokens";
import { semanticClass } from "@/lib/design/tokens";

type DataValueProps = {
  label?: string;
  value: React.ReactNode;
  suffix?: string;
  tone?: HudSemantic;
  mono?: boolean;
  className?: string;
};

export function DataValue({
  label,
  value,
  suffix,
  tone = "default",
  mono = true,
  className,
}: DataValueProps) {
  return (
    <div className={className}>
      {label && (
        <div className="text-[10px] uppercase tracking-[0.12em] text-[var(--text-muted)]">
          {label}
        </div>
      )}
      <div className={cn(mono && "font-mono-numeric", "text-[11px]", semanticClass[tone])}>
        {value}
        {suffix && <span className="text-[var(--text-muted)] ml-1">{suffix}</span>}
      </div>
    </div>
  );
}
