"use client";

import { useCallback, useMemo, useState } from "react";
import { WidgetShell } from "@/components/dashboard/WidgetShell";
import { EmptyState, FeedItem, LoadingRows, ScrollFeed, TagChip } from "@/components/ui";
import { useMockWebSocket } from "@/hooks/useMockWebSocket";
import { formatRelativeTime } from "@/lib/time";
import { generateGitHubEvent, type GitHubEvent } from "@/mocks/generators/github-feed";
import type { WidgetPanelProps } from "@/lib/layout/widget-registry";
import { useHudStore, type HudMode } from "@/store/hud-store";

const tagTone: Record<GitHubEvent["type"], "muted" | "gold" | "down"> = {
  commit: "muted",
  pr: "gold",
  issue: "down",
};

function GitHubFeed({ mode }: { mode: HudMode }) {
  const wsConnected = useHudStore((state) => state.wsConnected);
  const generate = useCallback(() => generateGitHubEvent(), []);
  const [events, setEvents] = useState<GitHubEvent[]>([]);
  const feedReady = useMockWebSocket<GitHubEvent>({
    feedId: "github",
    mode,
    generate,
    onMessage: (payload) => {
      if (mode === "focus" && payload.type === "commit") return;
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
    <WidgetShell title="GitHub Radar" code="WIDGET-B" live={wsConnected}>
      <div className="h-full p-2 min-h-0">
        <ScrollFeed>
          {feedReady === null && <LoadingRows rows={6} />}
          {visibleEvents.map((event) => (
            <FeedItem
              key={event.id}
              tag={<TagChip tone={tagTone[event.type]}>{event.type}</TagChip>}
              title={event.title}
              meta={`${event.repo} / ${event.author}`}
              time={formatRelativeTime(event.timestamp)}
            />
          ))}
          {feedReady && visibleEvents.length === 0 && (
            <EmptyState message="Waiting for repository events..." />
          )}
        </ScrollFeed>
      </div>
    </WidgetShell>
  );
}

export function GitHubRadar({ panelId }: WidgetPanelProps) {
  void panelId;
  const mode = useHudStore((state) => state.mode);
  return (
    <div className="h-full min-h-0" key={mode}>
      <GitHubFeed mode={mode} />
    </div>
  );
}
