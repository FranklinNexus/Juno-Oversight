"use client";

type SparklineProps = {
  values: number[];
  width?: number;
  height?: number;
  alert?: boolean;
};

export function Sparkline({
  values,
  width = 88,
  height = 22,
  alert = false,
}: SparklineProps) {
  if (values.length < 2) {
    return (
      <svg width={width} height={height} className="opacity-40" aria-hidden>
        <line
          x1={0}
          y1={height / 2}
          x2={width}
          y2={height / 2}
          stroke="var(--text-muted)"
          strokeWidth={1}
        />
      </svg>
    );
  }

  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const points = values
    .map((value, index) => {
      const x = (index / (values.length - 1)) * width;
      const y = height - ((value - min) / range) * (height - 2) - 1;
      return `${x},${y}`;
    })
    .join(" ");

  return (
    <svg width={width} height={height} className="block" aria-hidden>
      <polyline
        fill="none"
        stroke={alert ? "var(--accent-gold)" : "var(--text-porcelain)"}
        strokeWidth={1.2}
        points={points}
      />
    </svg>
  );
}
