const SIZE_ANIM_MS = 220;

let clearTimer: ReturnType<typeof setTimeout> | null = null;

export function pulseSizeAnimation(
  panelId: string,
  onPulse: (panelId: string) => void,
  onClear: () => void,
) {
  onPulse(panelId);
  if (clearTimer) clearTimeout(clearTimer);
  clearTimer = setTimeout(() => {
    onClear();
    clearTimer = null;
  }, SIZE_ANIM_MS);
}
