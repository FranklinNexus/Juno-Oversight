export function formatRelativeTime(timestamp: number, now = Date.now()): string {
  const sec = Math.max(1, Math.floor((now - timestamp) / 1000));
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h`;
  return `${Math.floor(sec / 86400)}d`;
}
