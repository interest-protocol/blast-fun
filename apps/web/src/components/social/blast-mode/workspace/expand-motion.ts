/**
 * A panel's expand: the full-page chart (the focus board) or the fixed panel grows out of its card and shrinks back
 * into it, on the Web Animations API. The element is laid out at its final size the whole time and only its
 * transform, clip and opacity move: it is scaled uniformly, so no text stretches, and clipped to the card's shape.
 * A press mid-motion continues from where the element is drawn. Keyboard input is instant; reduced motion fades the
 * expanded chart in and restores at once.
 */

import { EASE_OUT, T1, T2 } from "#web/components/blast-ui/motion-tokens.ts";

export const EXPAND_GROW_MS = 240;
export const EXPAND_SHRINK_MS = T2;
export const EXPAND_FADE_MS = T1;

export type Box = Readonly<{ left: number; top: number; width: number; height: number }>;
export type ExpandFrame = Readonly<{ transform: string; clipPath: string; opacity: number }>;

export function boxOf(element: Element): Box {
  const { left, top, width, height } = element.getBoundingClientRect();
  return { left, top, width, height };
}

/** The element's own corner radius (px). */
export function radiusOf(element: Element): number {
  const radius = Number.parseFloat(getComputedStyle(element).borderTopLeftRadius);
  return Number.isFinite(radius) ? radius : 0;
}

/** At rest where it is laid out, with its own corners. */
export function restFrame(radius: number): ExpandFrame {
  return { transform: "translate(0px, 0px) scale(1)", clipPath: `inset(0px 0px 0px 0px round ${radius}px)`, opacity: 1 };
}

/**
 * Draws an element laid out at `layout` over `card`: scaled uniformly (from its top-left corner) until it covers the
 * card, then clipped to the card's size and corners.
 */
export function cardFrame(card: Box, layout: Box, radius: number, opacity: number): ExpandFrame {
  const scale = Math.max(card.width / layout.width, card.height / layout.height);
  const right = Math.max(0, layout.width - card.width / scale);
  const bottom = Math.max(0, layout.height - card.height / scale);
  return {
    transform: `translate(${card.left - layout.left}px, ${card.top - layout.top}px) scale(${scale})`,
    clipPath: `inset(0px ${right}px ${bottom}px 0px round ${radius / scale}px)`,
    opacity,
  };
}

/** Where the element is drawn now (its running animation included), so a new motion starts from there. */
export function liveFrame(style: Readonly<{ transform: string; clipPath: string; opacity: string }>, rest: ExpandFrame): ExpandFrame {
  const matrix = /^matrix\(([^)]*)\)$/.exec(style.transform.trim());
  const values = matrix?.[1]!.split(",").map(Number);
  const opacity = Number.parseFloat(style.opacity);
  return {
    transform: values?.length === 6 ? `translate(${values[4]}px, ${values[5]}px) scale(${values[0]})` : rest.transform,
    clipPath: style.clipPath.startsWith("inset(") ? style.clipPath : rest.clipPath,
    opacity: Number.isFinite(opacity) ? opacity : 1,
  };
}

const ORIGIN = { transformOrigin: "0 0" } as const;

/** Grows the just-expanded element out of `card` (measured before it left). */
export function growFromCard(element: HTMLElement, card: Box, cardRadius: number): Animation {
  const layout = boxOf(element);
  return element.animate([{ ...cardFrame(card, layout, cardRadius, 0.9), ...ORIGIN }, { ...restFrame(radiusOf(element)), ...ORIGIN }], {
    duration: EXPAND_GROW_MS,
    easing: EASE_OUT,
  });
}

/** Reduced motion: the expanded element fades in where it stands. */
export function fadeIn(element: HTMLElement): Animation {
  return element.animate([{ opacity: 0 }, { opacity: 1 }], { duration: EXPAND_FADE_MS, easing: EASE_OUT });
}

/**
 * Shrinks the expanded element from where it is drawn into the card it returns to. `collapsed` answers that card's
 * box and corner radius with the element back in place. Held at its end (`fill: forwards`) until the restore commits.
 */
export function shrinkToCard(element: HTMLElement, collapsed: () => Readonly<{ card: Box; radius: number }>): Animation {
  const rest = restFrame(radiusOf(element));
  const from = liveFrame(getComputedStyle(element), rest);
  for (const animation of element.getAnimations()) animation.cancel();
  const layout = boxOf(element);
  const { card, radius } = collapsed();
  return element.animate([{ ...from, ...ORIGIN }, { ...cardFrame(card, layout, radius, 1), ...ORIGIN }], {
    duration: EXPAND_SHRINK_MS,
    easing: EASE_OUT,
    fill: "forwards",
  });
}
