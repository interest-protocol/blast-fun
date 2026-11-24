/**
 * A menu's own motion on the Web Animations API: the gate's version 5
 * `openMenu` and `closeMenu` (OA-31), for every menu on base-ui's `Menu`
 * (the account menu, the Create menu, a post's More menu).
 *
 * - **Desktop**: the menu grows from its trigger (`translateY(4px) scale(.98)` and opacity 0
 *   to rest, 160 ms `EASE_OUT`) and leaves shrinking to
 *   `scale(.97)` (130 ms `EASE_OUT`).
 * - **Phones** (≤760px): the menu is an action sheet docked to the bottom
 *   edge, so it rises from that edge like every other sheet
 *   (`translateY(calc(100% + 16px))` to rest, 240 ms
 *   `EASE_DRAWER`) and leaves the same way **from wherever it
 *   is** (180 ms `EASE_OUT`): mid-rise, it sinks from there.
 * - **Reduced motion**: a fade in place (120 ms in, 100 ms out, `EASE_OUT`), no movement.
 * - **Keyboard**: immediate state changes, in place.
 * - **Caught while closing**: opening cancels every animation on the menu
 *   first (the gate's `getAnimations().forEach(x => x.cancel())`), so a close
 *   still running never ends by hiding the menu that just reopened.
 *
 * The exit is held at its end (`fill: forwards`) until base-ui, which waits
 * for the popup's animations (`getAnimations()`), unmounts it; nothing is
 * left on a node that stays in the page. The CSSOM and the Web Animations
 * API are what the CSP allows (ui-libraries §2.3): nothing here writes a
 * `style` attribute.
 */

import { keyboardInput } from "./feedback-motion";
import { EASE_DRAWER, EASE_OUT } from "./motion-tokens";
import { prefersReducedMotion } from "./use-shell-prefs";

/** Phones: the menu docks to the bottom edge as an action sheet. */
export const MENU_PHONE_QUERY = "(max-width: 760px)";

export const MENU_GROW_MS = 160;
export const MENU_SHRINK_MS = 130;
export const MENU_RISE_MS = 240;
export const MENU_SINK_MS = 180;
export const MENU_FADE_IN_MS = 120;
export const MENU_FADE_OUT_MS = 100;

export const MENU_EASE_GROW = EASE_OUT;
export const MENU_EASE_RISE = EASE_DRAWER;
export const MENU_EASE_LEAVE = EASE_OUT;

/** Below the bottom edge, with the 16px a docked menu keeps from it and its shadow. */
const OFF_EDGE = "translateY(calc(100% + 16px))";

/** `reduce`: fade without moving; `instant` (the keyboard): no animation at all. */
export type MenuMotionMode = Readonly<{ phone: boolean; reduce: boolean; instant?: boolean }>;

/** The device's motion for a menu right now (checked at each opening and closing, so a rotated phone follows). */
export function menuMotionMode(): MenuMotionMode {
  if (typeof window === "undefined") return { phone: false, reduce: false };
  const instant = keyboardInput();
  return {
    phone: window.matchMedia(MENU_PHONE_QUERY).matches,
    reduce: instant || prefersReducedMotion(),
    instant,
  };
}

/** Reads the menu's live `transform` (its running animation included); a test passes its own. */
export type MenuTransformReader = (element: Element) => string;

export const computedTransform: MenuTransformReader = (element) => getComputedStyle(element).transform;

function cancelAll(element: Element): void {
  for (const animation of element.getAnimations()) animation.cancel();
}

/** The menu arrives: grows from its trigger, rises from the bottom edge (phones) or fades (reduced motion). */
export function openMenuMotion(menu: Element, { phone, reduce, instant = false }: MenuMotionMode): Animation {
  // Read before cancelling so reopening continues at the visible position and opacity.
  const live = menu.getAnimations().length ? getComputedStyle(menu) : null;
  const from = live?.transform || null;
  const opacity = Number.parseFloat(live?.opacity ?? "");
  const alpha = Number.isFinite(opacity) ? opacity : 1;
  cancelAll(menu);
  if (reduce) return menu.animate([{ opacity: live ? alpha : 0 }, { opacity: 1 }], { duration: instant ? 0 : MENU_FADE_IN_MS, easing: MENU_EASE_LEAVE });
  if (phone) return menu.animate([{ transform: from ?? OFF_EDGE }, { transform: "none" }], { duration: MENU_RISE_MS, easing: MENU_EASE_RISE });
  return menu.animate(
    [
      { opacity: from === null ? 0 : alpha, transform: from ?? "translateY(4px) scale(.98)" },
      { opacity: 1, transform: "none" },
    ],
    { duration: MENU_GROW_MS, easing: MENU_EASE_GROW },
  );
}

/**
 * The menu leaves: on phones it sinks from wherever it is (its live
 * transform is read before anything is cancelled), on desktop it shrinks
 * away, and under reduced motion it fades in place. Answers the exit, held
 * at its end until the menu is gone.
 */
export function closeMenuMotion(menu: Element, { phone, reduce, instant = false }: MenuMotionMode, read: MenuTransformReader = computedTransform): Animation {
  const from = !reduce ? read(menu) || "none" : "none";
  const opacity = Number.parseFloat(getComputedStyle(menu).opacity);
  const alpha = Number.isFinite(opacity) ? opacity : 1;
  cancelAll(menu);
  const keep = { fill: "forwards" } as const;
  if (reduce) return menu.animate([{ opacity: alpha }, { opacity: 0 }], { duration: instant ? 0 : MENU_FADE_OUT_MS, easing: MENU_EASE_LEAVE, ...keep });
  if (phone) return menu.animate([{ transform: from }, { transform: OFF_EDGE }], { duration: MENU_SINK_MS, easing: MENU_EASE_LEAVE, ...keep });
  return menu.animate(
    [
      { opacity: alpha, transform: from },
      { opacity: 0, transform: "scale(.97)" },
    ],
    { duration: MENU_SHRINK_MS, easing: MENU_EASE_LEAVE, ...keep },
  );
}
