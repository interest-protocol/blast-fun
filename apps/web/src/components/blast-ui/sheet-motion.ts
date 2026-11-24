import {
  exitTiming,
  SHEET_EASE_OUT,
  SHEET_EASE_RISE,
  SHEET_EASE_STD,
  SHEET_FADE_MS,
  SHEET_POP_MS,
  SHEET_RISE_MS,
  SHEET_SCRIM_IN_MS,
  springHome,
} from "./sheet-gesture-model";

/**
 * A sheet's own motion on the Web Animations API, the gate's version 5
 * `openLayer`, `closeLayer` and `swapSheet` (OA-31): the scrim fades in over
 * 180 ms; the sheet rises 200 ms from the bottom on phones or pops 200 ms
 * from slightly below elsewhere; it leaves in 160 ms, or at the
 * finger's speed after a pull, always from where it is on screen at that
 * moment (mid-drag, mid-open); a step swap slides out left and in from the
 * right. Under reduced motion the scrim and the sheet fade over 160 ms where
 * they stand and step changes are immediate; from the keyboard (`instant`)
 * nothing animates.
 *
 * The CSSOM and the Web Animations API are what the CSP allows (ui-libraries
 * §2.3); nothing here writes a `style` attribute.
 */

/** The parts of a computed style the motion reads; a test passes its own. */
export type SheetStyleReader = (element: Element) => Readonly<{ transform?: string; opacity?: string; overflowY?: string }>;

export const computedStyle: SheetStyleReader = (element) => getComputedStyle(element);

/** The vertical translation in a computed `transform` (`none`, `matrix(…)` or `matrix3d(…)`), 0 when there is none. */
export function translateYOf(transform: string | undefined): number {
  const match = /^matrix(3d)?\(([^)]*)\)$/.exec((transform ?? "").trim());
  if (match === null) return 0;
  const values = match[2]!.split(",").map((value) => Number(value));
  const y = match[1] === undefined ? values[5] : values[13];
  return y !== undefined && Number.isFinite(y) ? y : 0;
}

/** Where `element` is drawn right now, px below rest (its animations and inline transform included). */
export function liveTranslateY(element: Element, read: SheetStyleReader = computedStyle): number {
  return translateYOf(read(element).transform);
}

/** `element`'s opacity right now, 1 when it cannot be read. */
export function liveOpacity(element: Element, read: SheetStyleReader = computedStyle): number {
  const value = Number.parseFloat(read(element).opacity ?? "");
  return Number.isFinite(value) ? value : 1;
}

function cancelAll(element: Element): void {
  for (const animation of element.getAnimations()) animation.cancel();
}

/** `reduce`: fade without moving; `instant` (the keyboard): no animation at all. */
export type SheetMotionMode = Readonly<{ phone: boolean; reduce: boolean; instant?: boolean }>;

/** The sheet arrives: the scrim fades in, the sheet rises (phones), pops (wider) or fades (reduced motion). */
export function openSheetMotion(scrim: HTMLElement, sheet: HTMLElement, { phone, reduce, instant = false, resume = false }: SheetMotionMode & Readonly<{ resume?: boolean }>): void {
  const y = resume ? liveTranslateY(sheet) : 0;
  const opacity = resume ? liveOpacity(sheet) : 0;
  const scrimStart = resume ? liveOpacity(scrim) : 0;
  cancelAll(sheet);
  cancelAll(scrim);
  sheet.style.transform = "";
  scrim.style.opacity = "";
  const fade = instant ? 0 : SHEET_FADE_MS;
  scrim.animate([{ opacity: scrimStart }, { opacity: 1 }], { duration: reduce ? fade : SHEET_SCRIM_IN_MS, easing: SHEET_EASE_STD });
  if (reduce) {
    sheet.animate([{ opacity }, { opacity: 1 }], { duration: fade, easing: SHEET_EASE_STD });
    return;
  }
  if (resume && phone) {
    const spring = springHome(y, 0);
    sheet.animate(spring.frames.map((offset) => ({ transform: `translateY(${offset}px)` })), { duration: spring.durationMs, easing: "linear" });
    return;
  }
  sheet.animate(
    phone
      ? [{ transform: "translateY(100%)" }, { transform: "none" }]
      : [{ opacity, transform: `translateY(${resume ? y : 6}px)` }, { opacity: 1, transform: "none" }],
    { duration: phone ? SHEET_RISE_MS : SHEET_POP_MS, easing: phone ? SHEET_EASE_RISE : SHEET_EASE_OUT },
  );
}

/**
 * The sheet leaves from where it is: its live position and the scrim's live
 * opacity are read before anything is cancelled. `fling` (px/s, from a pull)
 * makes it leave at the finger's speed. Answers the sheet's exit, held at its
 * end (`fill: forwards`) until the sheet is gone.
 */
export function closeSheetMotion(
  scrim: HTMLElement,
  sheet: HTMLElement,
  { phone, reduce, instant = false, fling = 0, read = computedStyle }: SheetMotionMode & Readonly<{ fling?: number; read?: SheetStyleReader }>,
): Animation {
  const y0 = liveTranslateY(sheet, read);
  const o0 = liveOpacity(scrim, read);
  const sheetOpacity = liveOpacity(sheet, read);
  const height = sheet.offsetHeight || window.innerHeight;
  cancelAll(sheet);
  cancelAll(scrim);
  const timing = exitTiming(fling, height, y0, phone);
  const durationMs = reduce ? (instant ? 0 : SHEET_FADE_MS) : timing.durationMs;
  const easing = reduce ? SHEET_EASE_STD : timing.easing;
  scrim.animate([{ opacity: o0 }, { opacity: 0 }], { duration: durationMs, easing: SHEET_EASE_STD, fill: "forwards" });
  const keyframes =
    reduce
      ? [
          { opacity: sheetOpacity, transform: `translateY(${y0}px)` },
          { opacity: 0, transform: `translateY(${y0}px)` },
        ]
      : phone
        ? [{ transform: `translateY(${y0}px)` }, { transform: "translateY(100%)" }]
        : [
            { opacity: sheetOpacity, transform: `translateY(${y0}px)` },
            { opacity: 0, transform: "translateY(6px)" },
          ];
  return sheet.animate(keyframes, { duration: durationMs, easing, fill: "forwards" });
}

/**
 * A multi-step sheet's step change: the step slides out left (60 ms), then
 * `change` swaps it, then the next slides in from the right (120 ms); under
 * reduced motion the step changes immediately.
 */
export function swapSheetMotion(sheet: HTMLElement, change: () => void, { reduce }: Readonly<{ reduce: boolean }>): void {
  const opacity = liveOpacity(sheet);
  const transform = computedStyle(sheet).transform || "none";
  cancelAll(sheet);
  const coinFlow = sheet.hasAttribute("data-coin-flow");
  if (reduce || (coinFlow && document.documentElement.dataset.blastInput === "keyboard")) { change(); return; }
  const dx = coinFlow ? 4 : 8;
  const out = sheet.animate(
    [
      { opacity, transform },
      { opacity: 0, transform: `translateX(${-dx}px)` },
    ],
    { duration: 60, easing: SHEET_EASE_STD, fill: "forwards" },
  );
  out.onfinish = () => {
    change();
    out.cancel();
    sheet.animate(
      [
        { opacity: 0, transform: `translateX(${dx}px)` },
        { opacity: 1, transform: "none" },
      ],
      { duration: 120, easing: SHEET_EASE_OUT },
    );
  };
}
