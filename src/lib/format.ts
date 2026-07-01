export function formatRam(mb: number): string {
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)}G`;
  return `${Math.round(mb)}M`;
}

export function formatPrice(value: number, market?: string): string {
  if (market === "cn_a" || value >= 1000) return value.toFixed(2);
  if (value >= 100) return value.toFixed(2);
  if (value >= 1) return value.toFixed(3);
  return value.toFixed(4);
}

export function formatPct(value: number): string {
  const sign = value >= 0 ? "+" : "";
  return `${sign}${value.toFixed(2)}%`;
}

export function formatVolume24h(value: number | undefined, currency?: string, market?: string): string {
  if (value == null || Number.isNaN(value)) return "—";
  const unit = currency ?? (market === "cn_a" ? "CNY" : "USD");
  if (value >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(2)}B ${unit}`;
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M ${unit}`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K ${unit}`;
  return `${Math.round(value)} ${unit}`;
}

/** Mock 24h notional for list rows (OKX-style subtitle). */
export function formatNotional(value: number): string {
  if (value >= 1e8) return `${(value / 1e8).toFixed(2)}亿`;
  if (value >= 1e4) return `${(value / 1e4).toFixed(2)}万`;
  return `${value.toFixed(0)}`;
}
