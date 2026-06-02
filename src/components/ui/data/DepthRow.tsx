type DepthRowProps = {
  price: string;
  size: string;
  widthPct: number;
  side: "bid" | "ask";
};

export function DepthRow({ price, size, widthPct, side }: DepthRowProps) {
  const barColor = side === "bid" ? "var(--depth-bid)" : "var(--depth-ask)";

  return (
    <div className="relative grid grid-cols-[1fr_auto] gap-2 py-[1px]">
      <div
        className="absolute inset-y-0 opacity-30"
        style={{
          width: `${widthPct}%`,
          background: barColor,
          right: side === "bid" ? 0 : undefined,
          left: side === "ask" ? 0 : undefined,
        }}
      />
      <span className="relative font-mono-numeric text-[11px] text-[var(--text-porcelain)]">
        {price}
      </span>
      <span className="relative font-mono-numeric text-[11px] text-[var(--text-muted)]">
        {size}
      </span>
    </div>
  );
}
