import { type ReactNode } from "react";

type WidgetShellProps = {
  title: string;
  code: string;
  children: ReactNode;
  actions?: ReactNode;
};

export function WidgetShell({ title, code, children, actions }: WidgetShellProps) {
  return (
    <section className="border border-[var(--border-dim)] bg-[var(--bg-panel)] min-h-0">
      <header className="h-8 border-b border-[var(--border-dim)] px-2 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-[10px] tracking-[0.14em] uppercase text-[var(--text-muted)]">
            {code}
          </span>
          <span className="text-[11px] truncate">{title}</span>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {actions}
          <span className="text-[10px] text-[var(--status-ok)] font-mono-numeric">LIVE</span>
        </div>
      </header>
      <div className="h-[calc(100%-2rem)]">{children}</div>
    </section>
  );
}
