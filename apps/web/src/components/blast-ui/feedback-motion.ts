"use client";

import { useLayoutEffect, useRef, type RefObject } from "react";
import { prefersReducedMotion } from "./use-shell-prefs";
import { EASE_OUT } from "./motion-tokens";

/** The last input was the keyboard: nothing animates, fades included. */
export function keyboardInput(): boolean {
  return typeof document !== "undefined" && document.documentElement.dataset.blastInput === "keyboard";
}

/** Nothing moves: reduced motion or the keyboard. A fade may still run under reduced motion (`keyboardInput` says when it may not). */
export function instantFeedback(): boolean {
  return prefersReducedMotion() || keyboardInput();
}

/** Reveal one changed region, without remounting its inputs or replaying on refresh. */
export function useFeedbackReveal<T extends HTMLElement>(value: string, target: RefObject<T | null>, { duration = 140, offset = 0 } = {}) {
  const previous = useRef(value);
  useLayoutEffect(() => {
    if (previous.current === value) return;
    previous.current = value;
    if (instantFeedback() || !target.current?.animate) return;
    const frames = offset ? [
      { opacity: 0, transform: `translateY(${offset}px)` },
      { opacity: 1, transform: "translateY(0)" },
    ] : [{ opacity: .4 }, { opacity: 1 }];
    const animation = target.current.animate(frames, {
      duration,
      easing: EASE_OUT,
    });
    return () => animation.cancel();
  }, [value, target, duration, offset]);
}
