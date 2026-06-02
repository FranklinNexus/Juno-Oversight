import { type ReactNode } from "react";
import { LiveBadge } from "@/components/ui";

type WidgetShellProps = {
  title: string;
  code: string;
  children: ReactNode;
  actions?: ReactNode;
  /** When omitted, no feed badge is shown. */
  live?: boolean;
};

export function WidgetShell({ title, code, children, actions, live }: WidgetShellProps) {
  return (
    <section className="widget-panel h-full border-0 bg-[var(--bg-panel)] min-h-0">
      <header className="h-8 border-b border-[var(--border-dim)] px-2 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-[10px] tracking-[0.14em] uppercase text-[var(--text-muted)]">
            {code}
          </span>
          <span className="text-[11px] truncate">{title}</span>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {actions}
          {live !== undefined && <LiveBadge active={live} />}
        </div>
      </header>
      <div className="widget-panel-body h-[calc(100%-2rem)]">{children}</div>
    </section>
  );
}
