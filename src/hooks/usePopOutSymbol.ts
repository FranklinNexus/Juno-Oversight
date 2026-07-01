"use client";

import { useCallback, useRef, type PointerEvent as ReactPointerEvent } from "react";
import { useLayoutStore } from "@/store/layout-store";

const DRAG_THRESHOLD_PX = 12;

/**
 * ⠿ drag / ↗ click → focus existing symbol panel or create one (never duplicate per symbol).
 */
export function usePopOutSymbol(symbol: string) {
  const spawnMarketSymbolPanel = useLayoutStore((state) => state.spawnMarketSymbolPanel);
  const originRef = useRef<{ x: number; y: number } | null>(null);
  const movedRef = useRef(false);

  const popOut = useCallback(() => {
    spawnMarketSymbolPanel(symbol);
  }, [spawnMarketSymbolPanel, symbol]);

  const onPointerDown = useCallback((event: ReactPointerEvent) => {
    if (event.button !== 0) return;
    event.stopPropagation();
    originRef.current = { x: event.clientX, y: event.clientY };
    movedRef.current = false;
    event.currentTarget.setPointerCapture(event.pointerId);
  }, []);

  const onPointerMove = useCallback((event: ReactPointerEvent) => {
    event.stopPropagation();
    const origin = originRef.current;
    if (!origin) return;
    if (Math.hypot(event.clientX - origin.x, event.clientY - origin.y) >= DRAG_THRESHOLD_PX) {
      movedRef.current = true;
    }
  }, []);

  const onPointerUp = useCallback(
    (event: ReactPointerEvent) => {
      event.stopPropagation();
      const shouldPop = movedRef.current;
      originRef.current = null;
      movedRef.current = false;
      try {
        event.currentTarget.releasePointerCapture(event.pointerId);
      } catch {
        /* already released */
      }
      if (shouldPop) {
        event.preventDefault();
        popOut();
      }
    },
    [popOut],
  );

  return { onPointerDown, onPointerMove, onPointerUp, popOutNow: popOut };
}
