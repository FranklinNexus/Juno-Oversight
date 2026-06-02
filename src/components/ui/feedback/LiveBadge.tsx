import { cn } from "@/lib/cn";

type LiveBadgeProps = {
  active?: boolean;
};

export function LiveBadge({ active = true }: LiveBadgeProps) {
  return (
    <span
      className={cn(
        "text-[10px] font-mono-numeric uppercase tracking-[0.08em]",
        active ? "text-[var(--status-ok)]" : "text-[var(--text-muted)]",
      )}
    >
      {active ? "LIVE" : "OFFLINE"}
    </span>
  );
}
