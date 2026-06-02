"use client";

import { useEffect, useState } from "react";
import { createMockSocket } from "@/mocks/mock-websocket";
import { useHudStore, type HudMode } from "@/store/hud-store";

type UseMockWebSocketOptions<T> = {
  mode: HudMode;
  generate: () => T;
  onMessage?: (payload: T) => void;
};

export function useMockWebSocket<T>({ mode, generate, onMessage }: UseMockWebSocketOptions<T>) {
  const [data, setData] = useState<T | null>(null);
  const setConnection = useHudStore((state) => state.setConnection);

  useEffect(() => {
    const socket = createMockSocket<T>({
      mode,
      generate,
      onLatency: (latency) => setConnection(true, latency),
    });

    socket.onopen = () => setConnection(true, 15);
    socket.onclose = () => setConnection(false, 0);
    socket.onmessage = (event) => {
      const payload = JSON.parse(event.data) as T;
      setData(payload);
      onMessage?.(payload);
    };

    socket.connect();
    return () => socket.close();
  }, [mode, generate, setConnection, onMessage]);

  return data;
}
