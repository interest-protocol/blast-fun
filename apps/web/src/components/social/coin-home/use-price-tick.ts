import { useLayoutEffect, useRef, type RefObject } from "react";
import { compareDecimal } from "@blast/core/modules/social/items/decimal.ts";
import { instantFeedback } from "#web/components/blast-ui/feedback-motion.ts";
import { EASE_IN_OUT } from "#web/components/blast-ui/motion-tokens.ts";

/** Render the value normally. Only a change in the visible digits opens a color cue. */
export function usePriceTick(node: RefObject<HTMLSpanElement | null>, amount: string | null, display: string | null, at: number | null) {
  const prior = useRef({ amount, display, at });
  const pulse = useRef<Animation | null>(null);
  useLayoutEffect(() => () => pulse.current?.cancel(), []);
  useLayoutEffect(() => {
    const previous = prior.current;
    if (at !== null && previous.at !== null && at < previous.at) return;
    prior.current = { amount, display, at };
    const price = node.current;
    if (!price?.animate || !display || amount === null || previous.amount === null || at === null ||
      previous.at === null || document.visibilityState !== "visible" || instantFeedback()) {
      pulse.current?.cancel();
      return;
    }
    if (display === previous.display) return;
    const direction = compareDecimal(amount, previous.amount);
    if (!direction) return;
    const color = direction > 0 ? "var(--up)" : "var(--down)";
    price.style.setProperty("--home-price-direction", color);
    // A burst can change direction within the current fade, without replaying its bright first frame.
    if (pulse.current?.playState === "running" || pulse.current?.pending) return;
    pulse.current = price.animate([
      { color: "var(--home-price-direction)", offset: 0 },
      { color: "var(--home-price-direction)", offset: 0.6, easing: EASE_IN_OUT },
      { color: "var(--ink)" },
    ], { duration: 450 });
  }, [node, amount, display, at]);
}
