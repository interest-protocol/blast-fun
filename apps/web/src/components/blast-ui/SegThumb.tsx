"use client";

import { useLayoutEffect, useRef } from "react";

import { placeSegThumb, revealSegSelection } from "./seg-thumb-placement.ts";

/**
 * The segmented control's sliding thumb (`.seg-ind`), the one placement every
 * `.seg` in the app uses.
 *
 * The prototype's `placeSeg` offset the thumb by `on.offsetLeft - 3`, which
 * put it **3px to the left of its button everywhere**: `offsetLeft` is
 * measured from the control's padding edge, and `.seg-ind` is positioned from
 * the same edge (`left: 0`), so the control's own 3px padding is already
 * accounted for. The new reference fixed it to `on.offsetLeft` —
 * *"the thumb sits exactly on its button, 3px inset on every side"* — and
 * registered every control with a `ResizeObserver` so a row that reflows
 * (fonts landing, a description wrapping) never leaves the thumb misplaced.
 * `FEATURE-MAP-R3.md` §0.4 and §1 call this a fix the product must copy
 * (R3-03); it applies to every `.seg`, so it lives here rather than in each
 * control.
 */

let observer: ResizeObserver | null = null;

/** The shared observer that re-places a control's thumb when the control resizes. */
function segObserver(): ResizeObserver | null {
  if (observer) return observer;
  if (typeof ResizeObserver === "undefined") return null;
  observer = new ResizeObserver((entries) => {
    for (const entry of entries) {
      const seg = entry.target.classList.contains("seg") ? entry.target : entry.target.parentElement;
      if (entry.target.isConnected) placeSegThumb(seg as HTMLElement);
      else observer?.unobserve?.(entry.target);
    }
  });
  return observer;
}

/**
 * The thumb of the `.seg` it is rendered in, as its last child. `on` is the
 * control's current value: the thumb re-places itself whenever it changes,
 * and whenever the control's own size changes.
 */
export function SegThumb({ on }: Readonly<{ on: string | number | boolean }>) {
  const thumb = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const seg = thumb.current?.parentElement ?? null;
    if (!seg) return;
    placeSegThumb(seg);
    revealSegSelection(seg);
    const shared = segObserver();
    if (!shared) return;
    // A row wider than its card keeps its own size while a segment grows (fonts landing), so each segment is watched too.
    const watched = [seg, ...seg.querySelectorAll<HTMLElement>(":scope > :is(button, a)")];
    for (const element of watched) shared.observe(element);
    return () => { for (const element of watched) shared.unobserve?.(element); };
  }, [on]);
  return <span aria-hidden="true" className="seg-ind" ref={thumb} />;
}
