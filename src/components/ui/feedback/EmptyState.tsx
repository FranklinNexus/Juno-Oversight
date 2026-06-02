type EmptyStateProps = {
  message: string;
};

export function EmptyState({ message }: EmptyStateProps) {
  return <div className="text-xs text-[var(--text-muted)] px-1 py-2">{message}</div>;
}
