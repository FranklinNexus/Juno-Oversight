"use client";

import type { ButtonHTMLAttributes } from "react";
import { cn } from "@/lib/cn";

type HudButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  active?: boolean;
  variant?: "ghost" | "outline" | "danger";
  size?: "sm" | "md";
};

export function HudButton({
  active = false,
  variant = "outline",
  size = "sm",
  className,
  ...props
}: HudButtonProps) {
  return (
    <button
      type="button"
      className={cn(
        "uppercase tracking-[0.1em] border transition-colors",
        size === "sm" ? "h-6 px-1.5 text-[10px]" : "h-7 px-2 text-[11px]",
        variant === "ghost" && "border-transparent text-[var(--text-muted)] hover:text-[var(--text-porcelain)]",
        variant === "outline" &&
          (active
            ? "border-[var(--accent-gold)] text-[var(--accent-gold)]"
            : "border-[var(--border-dim)] text-[var(--text-muted)] hover:text-[var(--text-porcelain)] hover:border-[var(--border-strong)]"),
        variant === "danger" &&
          "border-[var(--border-dim)] text-[var(--down)] hover:border-[var(--status-warn)] disabled:opacity-40",
        className,
      )}
      {...props}
    />
  );
}
