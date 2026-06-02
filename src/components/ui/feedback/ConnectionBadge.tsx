import { cn } from "@/lib/cn";
import { StatusDot } from "@/components/ui/feedback/StatusDot";

type ConnectionBadgeProps = {
  connected: boolean;
  label?: string;
  latencyMs?: number;
  showLatency?: boolean;
  className?: string;
};

export function ConnectionBadge({
  connected,
  label = "WS",
  latencyMs,
  showLatency = true,
  className,
}: ConnectionBadgeProps) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 font-mono-numeric text-xs text-[var(--text-porcelain)]",
        className,
      )}
    >
      <StatusDot ok={connected} />
      <span>{connected ? label : "DISCONNECTED"}</span>
      {showLatency && connected && latencyMs != null && (
        <>
          <span className="text-[var(--text-muted)]">LAT</span>
          <span>{latencyMs}ms</span>
        </>
      )}
    </span>
  );
}
