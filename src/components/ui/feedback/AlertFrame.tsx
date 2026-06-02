import { cn } from "@/lib/cn";

type AlertFrameProps = {
  active?: boolean;
  children: React.ReactNode;
  className?: string;
};

export function AlertFrame({ active = false, children, className }: AlertFrameProps) {
  return (
    <div
      className={cn(
        "border p-2 h-full",
        active ? "border-[var(--accent-gold)]" : "border-[var(--border-dim)]",
        className,
      )}
    >
      {children}
    </div>
  );
}
