"use client";

import type { InputHTMLAttributes } from "react";
import { cn } from "@/lib/cn";

type HudInputProps = Omit<InputHTMLAttributes<HTMLInputElement>, "size"> & {
  size?: "sm" | "md";
  mono?: boolean;
};

export function HudInput({
  size = "sm",
  mono = true,
  className,
  ...props
}: HudInputProps) {
  return (
    <input
      className={cn(
        "w-full bg-[var(--bg-base)] border border-[var(--border-dim)] text-[var(--text-porcelain)] placeholder:text-[var(--text-muted)] outline-none focus:border-[var(--accent-gold)]",
        mono && "font-mono-numeric",
        size === "sm" ? "h-6 px-1.5 text-[10px] tracking-[0.06em]" : "h-7 px-2 text-[11px]",
        className,
      )}
      {...props}
    />
  );
}
