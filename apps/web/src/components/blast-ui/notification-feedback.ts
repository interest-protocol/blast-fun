"use client";

import { useEffect, type RefObject } from "react";
import { prefersReducedMotion, useReducedMotion } from "./use-shell-prefs";

export type SubscribeNotificationArrivals = (listener: () => void) => () => void;

/** Ephemeral delivery feedback: no stored effect to replay when a bell remounts. */
export function useNotificationFeedback(subscribe: SubscribeNotificationArrivals | undefined, halo: RefObject<HTMLElement | null>, badge: RefObject<HTMLElement | null>) {
  const reduced = useReducedMotion();
  useEffect(() => {
    if (!subscribe || reduced) return;
    let frame: number | null = null;
    let animations: Animation[] = [];
    const cancel = () => {
      if (frame !== null) cancelAnimationFrame(frame);
      frame = null;
      for (const animation of animations) animation.cancel();
      animations = [];
    };
    const off = subscribe(() => {
      if (frame !== null) return;
      // Wait for the immediately updated count to commit; coalesce synchronous deliveries.
      frame = requestAnimationFrame(() => {
        cancel();
        if (document.visibilityState !== "visible" || prefersReducedMotion() || !halo.current?.animate) return;
        const easing = getComputedStyle(halo.current).getPropertyValue("--ease").trim();
        animations.push(halo.current.animate([
          { opacity: 0, transform: "scale(.96)" },
          { opacity: .28, transform: "scale(1)", offset: .25 },
          { opacity: 0, transform: "scale(1.12)" },
        ], { duration: 240, easing }));
        if (badge.current && !badge.current.hasAttribute("data-empty")) {
          animations.push(badge.current.animate([{ opacity: .45 }, { opacity: 1 }], { duration: 200, easing }));
        }
      });
    });
    document.addEventListener("visibilitychange", cancel);
    return () => { off(); cancel(); document.removeEventListener("visibilitychange", cancel); };
  }, [subscribe, reduced, halo, badge]);
}
