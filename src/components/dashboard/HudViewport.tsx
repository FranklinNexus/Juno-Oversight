"use client";

import { useEffect, useMemo, type ReactNode } from "react";
import { useHudStore } from "@/store/hud-store";

const BASE_WIDTH = 1440;
const BASE_HEIGHT = 900;

type HudViewportProps = {
  children: ReactNode;
};

export function HudViewport({ children }: HudViewportProps) {
  const uiScale = useHudStore((state) => state.uiScale);
  const autoFit = useHudStore((state) => state.autoFit);
  const applyUiScale = useHudStore((state) => state.applyUiScale);

  const stageStyle = useMemo(
    () => ({
      transform: `scale(${uiScale})`,
      transformOrigin: "top left" as const,
      width: `${100 / uiScale}%`,
      height: `${100 / uiScale}%`,
    }),
    [uiScale],
  );

  useEffect(() => {
    if (!autoFit) return;

    const fit = () => {
      const scaleW = window.innerWidth / BASE_WIDTH;
      const scaleH = window.innerHeight / BASE_HEIGHT;
      const next = Math.max(0.75, Math.min(1.35, Math.min(scaleW, scaleH)));
      applyUiScale(next);
    };

    fit();
    window.addEventListener("resize", fit);
    return () => window.removeEventListener("resize", fit);
  }, [autoFit, applyUiScale]);

  return (
    <div className="hud-viewport">
      <div className="hud-scale-stage" style={stageStyle}>
        {children}
      </div>
    </div>
  );
}
