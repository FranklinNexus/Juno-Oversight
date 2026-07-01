"use client";

type MiniSparklineProps = {
  values: number[];
  width?: number;
  height?: number;
  alert?: boolean;
};

export function MiniSparkline({
  values,
  width = 88,
  height = 22,
  alert = false,
}: MiniSparklineProps) {
  if (values.length < 2) {
    return (
      <svg width={width} height={height} className="opacity-40">
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

  const stroke = alert ? "var(--accent-gold)" : "var(--text-porcelain)";

  return (
    <svg width={width} height={height} className="block">
      <polyline
        fill="none"
        stroke={stroke}
        strokeWidth={1.2}
        points={points}
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}
