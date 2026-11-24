import type { KeyboardEvent } from "react";

/**
 * True for an Enter keydown that should act, false while an input method is still confirming a character.
 * `keyCode` is deprecated, but Safari reports `isComposing` as already false on the confirming Enter keydown
 * while still sending 229; the guide pairs the two (modern-web-guidance: ime-safe-enter-submit).
 */
export function isEnterSubmit(event: Pick<KeyboardEvent, "key" | "nativeEvent">): boolean {
  return event.key === "Enter" && !(event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229);
}
