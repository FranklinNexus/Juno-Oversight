import { cn } from "@/lib/cn";

type StatusDotProps = {
  ok?: boolean;
  className?: string;
};

export function StatusDot({ ok = false, className }: StatusDotProps) {
  return (
    <span
      className={cn(
        "inline-block size-2 shrink-0",
        ok ? "bg-[var(--status-ok)]" : "bg-[var(--status-warn)]",
        className,
      )}
    />
  );
}
