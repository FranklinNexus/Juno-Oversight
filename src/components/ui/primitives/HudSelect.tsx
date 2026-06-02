"use client";

import type { SelectHTMLAttributes } from "react";
import { cn } from "@/lib/cn";

type HudSelectProps = SelectHTMLAttributes<HTMLSelectElement>;

export function HudSelect({ className, ...props }: HudSelectProps) {
  return (
    <select
      className={cn(
        "h-5 bg-[var(--bg-panel)] border border-[var(--border-dim)]",
        "text-[10px] uppercase tracking-[0.06em] text-[var(--text-porcelain)] px-1",
        "focus:outline-none focus:border-[var(--accent-gold)]",
        className,
      )}
      {...props}
    />
  );
}
