"use client";

import { HudButton } from "@/components/ui/primitives/HudButton";

export type SegmentOption<T extends string> = {
  id: T;
  label: string;
};

type HudSegmentProps<T extends string> = {
  value: T;
  options: SegmentOption<T>[];
  onChange: (value: T) => void;
  className?: string;
};

export function HudSegment<T extends string>({
  value,
  options,
  onChange,
  className,
}: HudSegmentProps<T>) {
  return (
    <div className={className ?? "flex flex-wrap gap-1"}>
      {options.map((option) => (
        <HudButton
          key={option.id}
          active={value === option.id}
          onClick={() => onChange(option.id)}
        >
          {option.label}
        </HudButton>
      ))}
    </div>
  );
}
