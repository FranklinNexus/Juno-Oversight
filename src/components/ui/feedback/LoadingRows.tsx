import { cn } from "@/lib/cn";

type LoadingRowsProps = {
  rows?: number;
  className?: string;
};

export function LoadingRows({ rows = 4, className }: LoadingRowsProps) {
  return (
    <div className={cn("space-y-1", className)} aria-busy aria-label="Loading">
      {Array.from({ length: rows }, (_, i) => (
        <div
          key={i}
          className="h-5 border-b border-[var(--border-dim)] bg-[var(--bg-hover)] animate-pulse"
          style={{ opacity: 1 - i * 0.12 }}
        />
      ))}
    </div>
  );
}

export function SkeletonBlock({ className }: { className?: string }) {
  return (
    <div
      className={cn(
        "bg-[var(--bg-hover)] border border-[var(--border-dim)] animate-pulse",
        className,
      )}
    />
  );
}
