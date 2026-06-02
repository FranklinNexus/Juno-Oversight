"use client";

import { useCallback, useMemo, useState } from "react";
import { WidgetShell } from "@/components/dashboard/WidgetShell";
import { useMockWebSocket } from "@/hooks/useMockWebSocket";
import { generateGitHubEvent, type GitHubEvent } from "@/mocks/generators/github-feed";
import { useHudStore } from "@/store/hud-store";

function relativeTime(timestamp: number) {
  const sec = Math.max(1, Math.floor((Date.now() - timestamp) / 1000));
  if (sec < 60) return `${sec}s ago`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
  return `${Math.floor(sec / 3600)}h ago`;
}

const typeTone: Record<GitHubEvent["type"], string> = {
  commit: "text-cyan-300",
  pr: "text-[var(--accent-gold)]",
  issue: "text-rose-300",
};

export function GitHubRadar() {
  const mode = useHudStore((state) => state.mode);
  const generate = useCallback(() => generateGitHubEvent(), []);
  const [events, setEvents] = useState<GitHubEvent[]>([]);
  useMockWebSocket<GitHubEvent>({
    mode,
    generate,
    onMessage: (payload) => {
      setEvents((prev) => [payload, ...prev].slice(0, 50));
    },
  });

  const visibleEvents = useMemo(() => {
    if (mode === "focus") {
      return events.filter((event) => event.type !== "commit");
    }
    return events;
  }, [events, mode]);

  return (
    <div style={{ gridArea: "github" }}>
      <WidgetShell title="GitHub Radar" code="WIDGET-B">
        <div className="h-full p-2 overflow-y-auto space-y-1">
          {visibleEvents.map((event) => (
            <div key={event.id} className="border border-[var(--border-dim)] px-2 py-1">
              <div className="flex items-center justify-between gap-2">
                <span className={`text-[10px] uppercase tracking-[0.12em] ${typeTone[event.type]}`}>
                  {event.type}
                </span>
                <span className="font-mono-numeric text-[10px] text-[var(--text-muted)]">
                  {relativeTime(event.timestamp)}
                </span>
              </div>
              <div className="text-xs mt-1">{event.title}</div>
              <div className="text-[10px] text-[var(--text-muted)] mt-1">
                {event.repo} / {event.author}
              </div>
            </div>
          ))}
          {visibleEvents.length === 0 && (
            <div className="text-xs text-[var(--text-muted)]">Waiting for repository events...</div>
          )}
        </div>
      </WidgetShell>
    </div>
  );
}
