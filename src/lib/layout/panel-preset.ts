import { SIZE_PRESETS, type PanelSizePreset } from "@/lib/layout/constants";
import type { PanelState } from "@/lib/layout/types";

export function matchPanelPreset(panel: Pick<PanelState, "w" | "h">): PanelSizePreset | null {
  for (const preset of Object.keys(SIZE_PRESETS) as PanelSizePreset[]) {
    const size = SIZE_PRESETS[preset];
    if (panel.w === size.w && panel.h === size.h) return preset;
  }
  return null;
}
