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
