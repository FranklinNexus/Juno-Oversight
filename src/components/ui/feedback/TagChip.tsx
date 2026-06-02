import { cn } from "@/lib/cn";
import type { HudSemantic } from "@/lib/design/tokens";
import { semanticClass } from "@/lib/design/tokens";

type TagChipProps = {
  children: React.ReactNode;
  tone?: HudSemantic;
};

export function TagChip({ children, tone = "muted" }: TagChipProps) {
  return (
    <span
      className={cn(
        "text-[10px] uppercase tracking-[0.12em]",
        semanticClass[tone],
      )}
    >
      {children}
    </span>
  );
}
