"use client";

import { useEffect, useId, useRef, useState } from "react";
import {
  registerMockFeed,
  reportMockFeedLatency,
  unregisterMockFeed,
} from "@/lib/mock-feed-connection";
import { createMockSocket } from "@/mocks/mock-websocket";
import type { HudMode } from "@/store/hud-store";

type UseMockWebSocketOptions<T> = {
  feedId: string;
  mode: HudMode;
  generate: () => T;
  onMessage?: (payload: T) => void;
};

export function useMockWebSocket<T>({
  feedId,
  mode,
  generate,
  onMessage,
}: UseMockWebSocketOptions<T>) {
  const [data, setData] = useState<T | null>(null);
  const reactId = useId();
  const instanceId = `${feedId}${reactId}`;
  const onMessageRef = useRef(onMessage);

  useEffect(() => {
    onMessageRef.current = onMessage;
  }, [onMessage]);

  useEffect(() => {
    const socket = createMockSocket<T>({
      mode,
      generate,
      onLatency: (latency) => reportMockFeedLatency(instanceId, latency),
    });

    registerMockFeed(instanceId);
    socket.onopen = () => registerMockFeed(instanceId, 15);
    socket.onmessage = (event) => {
      try {
        const payload = JSON.parse(event.data) as T;
        setData(payload);
        onMessageRef.current?.(payload);
      } catch {
        // Ignore malformed frames until real WS error handling lands.
      }
    };

    socket.connect();
    return () => {
      socket.close();
      unregisterMockFeed(instanceId);
    };
  }, [instanceId, mode, generate]);

  return data;
}
