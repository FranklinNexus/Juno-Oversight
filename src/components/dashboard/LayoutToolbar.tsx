"use client";

import { HudButton } from "@/components/ui";
import { LAYOUT_PRESETS, type LayoutPresetId } from "@/lib/layout/presets";
import { useLayoutStore } from "@/store/layout-store";

export function LayoutToolbar() {
  const saveCurrentLayout = useLayoutStore((state) => state.saveCurrentLayout);
  const restoreSavedLayout = useLayoutStore((state) => state.restoreSavedLayout);
  const resetLayout = useLayoutStore((state) => state.resetLayout);
  const applyLayoutPreset = useLayoutStore((state) => state.applyLayoutPreset);
  const hasSnapshot = useLayoutStore((state) => state.savedSnapshot !== null);

  return (
    <div className="flex items-center gap-1 border-l border-[var(--border-dim)] pl-2 ml-1">
      <HudButton onClick={saveCurrentLayout}>Save</HudButton>
      <HudButton active={hasSnapshot} onClick={restoreSavedLayout}>
        Load
      </HudButton>
      <HudButton onClick={resetLayout}>Reset</HudButton>
      {(Object.keys(LAYOUT_PRESETS) as LayoutPresetId[]).map((preset) => (
        <HudButton key={preset} onClick={() => applyLayoutPreset(preset)}>
          {LAYOUT_PRESETS[preset].label.split(" ")[0]}
        </HudButton>
      ))}
    </div>
  );
}
