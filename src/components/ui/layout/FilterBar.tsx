"use client";

import { HudInput } from "@/components/ui/primitives/HudInput";
import { cn } from "@/lib/cn";
import type { ReactNode } from "react";

type FilterBarProps = {
  query?: string;
  onQueryChange?: (value: string) => void;
  placeholder?: string;
  trailing?: ReactNode;
  className?: string;
};

export function FilterBar({
  query = "",
  onQueryChange,
  placeholder = "Filter...",
  trailing,
  className,
}: FilterBarProps) {
  return (
    <div
      className={cn(
        "flex items-center gap-2 border-b border-[var(--border-dim)] px-2 py-1",
        className,
      )}
    >
      {onQueryChange && (
        <HudInput
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
          placeholder={placeholder}
          className="max-w-[160px]"
        />
      )}
      {trailing && <div className="flex items-center gap-1 ml-auto">{trailing}</div>}
    </div>
  );
}
