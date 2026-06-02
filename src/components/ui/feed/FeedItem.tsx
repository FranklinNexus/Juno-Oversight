type FeedItemProps = {
  tag: React.ReactNode;
  title: string;
  meta?: string;
  time?: string;
};

export function FeedItem({ tag, title, meta, time }: FeedItemProps) {
  return (
    <div className="border border-[var(--border-dim)] px-2 py-1">
      <div className="flex items-center justify-between gap-2">
        {tag}
        {time && (
          <span className="font-mono-numeric text-[10px] text-[var(--text-muted)]">{time}</span>
        )}
      </div>
      <div className="text-xs mt-1 text-[var(--text-porcelain)]">{title}</div>
      {meta && <div className="text-[10px] text-[var(--text-muted)] mt-1">{meta}</div>}
    </div>
  );
}
