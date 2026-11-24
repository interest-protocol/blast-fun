import { scheduleDelay } from "./schedule-delay.ts";

type FocusTarget = () => HTMLElement | null | undefined;

export function focusNextFrame(target: FocusTarget, options?: FocusOptions): number {
  return requestAnimationFrame(() => target()?.focus(options));
}

export function focusAfterDelay(target: FocusTarget, delay: number, options?: FocusOptions): () => void {
  return scheduleDelay(() => target()?.focus(options), delay);
}
