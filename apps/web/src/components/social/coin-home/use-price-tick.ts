import { useLayoutEffect, useRef, type RefObject } from "react";
import { compareDecimal } from "@blast/core/modules/social/items/decimal.ts";
import { instantFeedback } from "#web/components/blast-ui/feedback-motion.ts";
import { EASE_IN_OUT } from "#web/components/blast-ui/motion-tokens.ts";
import type { HomeTrade } from "./use-home-prices";

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
    if (!price?.animate || !display || !previous.display || amount === null || previous.amount === null || at === null ||
      previous.at === null || document.visibilityState !== "visible" || instantFeedback()) {
      pulse.current?.cancel();
      return;
    }
    if (display === previous.display) return;
    const direction = compareDecimal(amount, previous.amount);
    if (!direction) return;
    cue(price, pulse, direction, "color");
  }, [node, amount, display, at]);
}

/**
 * A trade on this coin alone, newer than the last one seen, washes the figure if its visible digits changed, or the
 * cell when it has no figure to compare (a dash, or the first figure after one). The wash is a background, like the
 * chart's last trade, so the figure keeps its own green or red throughout.
 */
export function useTradeTick(node: RefObject<HTMLSpanElement | null>, display: string | null, trade: HomeTrade | null) {
  const prior = useRef({ display, at: trade?.at ?? null });
  const pulse = useRef<Animation | null>(null);
  useLayoutEffect(() => () => pulse.current?.cancel(), []);
  useLayoutEffect(() => {
    const previous = prior.current;
    prior.current = { display, at: trade?.at ?? previous.at };
    const price = node.current;
    if (!trade || (previous.at !== null && trade.at <= previous.at) || (display !== null && display === previous.display) ||
      !price?.animate || document.visibilityState !== "visible" || instantFeedback()) return;
    cue(price, pulse, trade.direction, "wash");
  }, [node, display, trade]);
}

function cue(price: HTMLSpanElement, pulse: RefObject<Animation | null>, direction: number, kind: "color" | "wash") {
  const up = direction > 0;
  price.style.setProperty("--home-price-direction", kind === "color" ? (up ? "var(--up)" : "var(--down)") : (up ? "var(--up-soft)" : "var(--down-soft)"));
  // A burst can change direction within the current fade, without replaying its bright first frame. A fade still
  // running on a replaced element (the dash a first figure took over) does not count.
  const running = pulse.current?.playState === "running" || pulse.current?.pending;
  if (running && (pulse.current?.effect as KeyframeEffect | null | undefined)?.target === price) return;
  const property = kind === "color" ? "color" : "backgroundColor";
  pulse.current = price.animate([
    { [property]: "var(--home-price-direction)", offset: 0 },
    // No end frame: the fade returns to the figure's own colour or background, with no step at the end.
    { [property]: "var(--home-price-direction)", offset: 0.6, easing: EASE_IN_OUT },
  ], { duration: 450 });
}
