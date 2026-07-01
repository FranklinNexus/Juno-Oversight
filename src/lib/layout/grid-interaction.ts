const BODY_CLASS = "hud-grid-interacting";

let interactionDepth = 0;

export function beginGridInteraction() {
  interactionDepth += 1;
  document.body.classList.add(BODY_CLASS);
}

export function endGridInteraction() {
  interactionDepth = Math.max(0, interactionDepth - 1);
  if (interactionDepth === 0) {
    document.body.classList.remove(BODY_CLASS);
  }
}

export function resetGridInteraction() {
  interactionDepth = 0;
  document.body.classList.remove(BODY_CLASS);
}
