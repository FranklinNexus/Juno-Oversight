import { cn } from "@/lib/cn";

type SectionLabelProps = {
  children: React.ReactNode;
  className?: string;
  tone?: "default" | "bid" | "ask" | "gold";
};

const toneClass = {
  default: "text-[var(--text-muted)]",
  bid: "text-[var(--bid)]",
  ask: "text-[var(--ask)]",
  gold: "text-[var(--accent-gold)]",
};

export function SectionLabel({ children, className, tone = "default" }: SectionLabelProps) {
  return (
    <div
      className={cn(
        "text-[10px] uppercase tracking-[0.12em] mb-1",
        toneClass[tone],
        className,
      )}
    >
      {children}
    </div>
  );
}
