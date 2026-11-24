/**
 * The motion tokens for script (the Web Animations API, motion), which can't read CSS custom properties: the same
 * values as blast-ui.css's `--ease-std`, `--ease-io`, `--ease-drawer` and `--t1`…`--t4`. UI motion lasts 300ms or
 * less; modals and drawers may run 200–500ms.
 */

/** `--ease-std`: the strong ease-out, for anything entering or leaving. */
export const EASE_OUT = "cubic-bezier(.23,1,.32,1)";
/** `--ease-io`: the strong ease-in-out, for something moving on screen. */
export const EASE_IN_OUT = "cubic-bezier(.77,0,.175,1)";
/** `--ease-drawer`: sidebars and sheets. */
export const EASE_DRAWER = "cubic-bezier(.32,.72,0,1)";

/** `EASE_OUT` as motion's cubic-bezier array. */
export const EASE_OUT_ARRAY = [0.23, 1, 0.32, 1] as const;

/** `--t1`…`--t4`, in milliseconds. */
export const T1 = 120;
export const T2 = 200;
export const T3 = 280;
export const T4 = 300;

/** A group entering together (new posts, a loaded page of rows) staggers by 40ms an item, capped at the sixth (240ms). */
export const STAGGER_MS = 40;
export const STAGGER_CAP = 6;

/** The entrance delay of the `index`th item in a group. Items are present, and clickable, from the start. */
export function staggerDelay(index: number): number {
  return Math.min(Math.max(0, index), STAGGER_CAP) * STAGGER_MS;
}
