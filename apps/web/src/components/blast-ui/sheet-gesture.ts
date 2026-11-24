import { computedStyle, liveTranslateY, type SheetStyleReader } from "./sheet-motion";
import { scrimOpacity, springHome, SHEET_HANDLE_PX, SheetDragGesture, type DragRelease } from "./sheet-gesture-model";

/**
 * The phone sheet's pull-down on the page (OA-31, OA-28 M2): the gate's
 * version 5 `sheetDrag`, shared by every sheet (`Sheet.tsx`); the numbers are
 * `sheet-gesture-model.ts`'s.
 *
 * - **Where a pull starts.** A touch anywhere on the sheet once the content
 *   under it is scrolled to the top, or on the handle (the top 44 px), never
 *   on a field (`input`, `textarea`, `select`, `[contenteditable]`) or a
 *   `.no-drag` part. A mouse or pen pulls by the handle only, and never from
 *   a control. A press that moves sideways first belongs to a sideways
 *   scroller; one that moves up from the content scrolls it.
 * - **Touch, not pointers, for fingers.** `touchmove` is listened to without
 *   `passive`, so a pull at the top can stop the content's own scroll;
 *   pointer events stay for the mouse and the pen.
 * - **What it draws.** The sheet's inline `transform` and the scrim's
 *   opacity (never below .25) while held, `data-dragging` (no text
 *   selection) on the sheet; on release either `close(fling)` — the sheet
 *   leaves from where it is at the finger's speed (`closeSheetMotion`) — or
 *   the spring home as keyframes over the resting state.
 * - **Caught mid-motion.** A pull that starts while the sheet is still
 *   rising, or springing home, starts from where it is drawn: every running
 *   animation on the sheet and the scrim is finished (a step swap still
 *   lands) and the live position is held inline. A closing sheet can be caught when its owner supports reopening.
 */

export type SheetGestureHost = Readonly<{
  sheet: HTMLElement;
  scrim: HTMLElement;
  /** Whether a pull may start now: phones only (≤760 px). */
  enabled: () => boolean;
  /** The sheet is on its way out. */
  closing: () => boolean;
  /** Released past half its height: ask to close, leaving at `fling` px/s. */
  close: (fling: number) => void;
  /** Catch a dismissing sheet when its owner supports reopening. */
  reopen?: () => void;
  reduce?: () => boolean;
  /** The computed style reader (a test's own). */
  read?: SheetStyleReader;
}>;

/** A field or a part that keeps its own gestures. */
const KEEPS_ITS_GESTURES = "input, textarea, select, [contenteditable], .no-drag";
/** A control a mouse press must reach. */
const CONTROL = 'button, a, [role="button"]';

/** Draws the sheet `offset` px below rest and fades the scrim with it; 0 hands the sheet back to its resting style. */
export function drawSheetAt(sheet: HTMLElement, scrim: HTMLElement, offset: number): void {
  sheet.style.transform = offset ? `translateY(${offset}px)` : "";
  scrim.style.opacity = String(scrimOpacity(offset, sheet.offsetHeight || window.innerHeight));
}

/** The spring home from `release.offset`, at the release's speed: rest is the inline state, and the spring plays over it. */
export function springSheetHome(sheet: HTMLElement, scrim: HTMLElement, release: Extract<DragRelease, { kind: "home" }>, reduce = false): void {
  const height = sheet.offsetHeight || window.innerHeight;
  drawSheetAt(sheet, scrim, 0);
  if (reduce) return;
  const timing = { duration: release.durationMs, easing: "linear" };
  sheet.animate(
    release.frames.map((y) => ({ transform: `translateY(${y}px)` })),
    timing,
  );
  scrim.animate(
    release.frames.map((y) => ({ opacity: scrimOpacity(y, height) })),
    timing,
  );
}

/** Whether `target`, or a scroller between it and the scrim, is scrolled away from its top. */
function scrolledAway(target: Element, scrim: HTMLElement, read: SheetStyleReader): boolean {
  for (let node: Element | null = target; node !== null && node !== scrim; node = node.parentElement) {
    if (node.scrollTop > 0 && /auto|scroll/.test(read(node).overflowY ?? "")) return true;
  }
  return false;
}

type Touchy = Event & Readonly<{ touches: ArrayLike<Readonly<{ clientX: number; clientY: number }>> }>;
type Pointery = Event & Readonly<{ pointerId: number; pointerType: string; button: number; clientX: number; clientY: number }>;

/** Binds the pull-down to `host.sheet`; the function it returns unbinds it, mid-gesture included. */
export function bindSheetGesture(host: SheetGestureHost): () => void {
  const { sheet, scrim } = host;
  const read = host.read ?? computedStyle;
  let gesture: SheetDragGesture | null = null;
  const height = () => sheet.offsetHeight || window.innerHeight;

  const begin = (x: number, y: number, target: EventTarget | null) => {
    gesture = null;
    if (!host.enabled() || !(target instanceof Element)) return;
    if (target.closest(KEEPS_ITS_GESTURES) !== null || scrolledAway(target, scrim, read)) return;
    gesture = new SheetDragGesture(x, y, y - sheet.getBoundingClientRect().top < SHEET_HANDLE_PX);
  };

  /** Answers whether the sheet is being pulled (so the content must not scroll). */
  const move = (x: number, y: number, timeMs: number): boolean => {
    const held = gesture;
    if (held === null) return false;
    const step = held.move(x, y, timeMs, {
      closing: () => {
        if (!host.closing()) return false;
        if (!host.reopen) return true;
        host.reopen();
        return host.closing();
      },
      base: () => {
        // Its live position, mid-open or mid-spring, read before the motion is finished.
        const base = liveTranslateY(sheet, read);
        for (const animation of sheet.getAnimations()) animation.finish();
        for (const animation of scrim.getAnimations()) animation.finish();
        return base;
      },
      height,
    });
    if (step.kind === "cancel") {
      gesture = null;
      return false;
    }
    if (step.kind === "wait") return false;
    if (step.started) sheet.setAttribute("data-dragging", "");
    drawSheetAt(sheet, scrim, step.offset);
    return true;
  };

  const end = (event: Event | undefined, cancelled = false) => {
    const held = gesture;
    gesture = null;
    if (held === null) return;
    const release = cancelled && held.tracking ? springHome(held.offset, 0) : held.release(event?.timeStamp, height());
    if (release === null) return;
    sheet.removeAttribute("data-dragging");
    if (release.kind === "close") host.close(release.fling);
    else springSheetHome(sheet, scrim, release, host.reduce?.());
  };

  const onTouchStart = (event: Event) => {
    const touches = (event as Touchy).touches;
    if (touches.length === 1) begin(touches[0]!.clientX, touches[0]!.clientY, event.target);
    else end(event, true);
  };
  const onTouchMove = (event: Event) => {
    const touch = (event as Touchy).touches[0];
    if (gesture !== null && touch !== undefined && move(touch.clientX, touch.clientY, event.timeStamp) && event.cancelable) event.preventDefault();
  };
  const onPointerDown = (event: Event) => {
    const press = event as Pointery;
    if (press.pointerType === "touch" || press.button > 0) return;
    if (press.target instanceof Element && press.target.closest(CONTROL) !== null) return;
    begin(press.clientX, press.clientY, press.target);
    if (gesture === null) return;
    if (!gesture.handle) {
      gesture = null;
      return;
    }
    try {
      sheet.setPointerCapture(press.pointerId);
    } catch {
      // The capture is a nicety: the sheet still hears the moves over it.
    }
  };
  const onPointerMove = (event: Event) => {
    const pointer = event as Pointery;
    if (pointer.pointerType !== "touch" && gesture !== null) move(pointer.clientX, pointer.clientY, pointer.timeStamp);
  };
  const onPointerEnd = (event: Event) => {
    if ((event as Pointery).pointerType !== "touch") end(event);
  };

  const listeners: readonly (readonly [string, (event: Event) => void, AddEventListenerOptions?])[] = [
    ["touchstart", onTouchStart, { passive: true }],
    ["touchmove", onTouchMove, { passive: false }],
    ["touchend", (event) => end(event)],
    ["touchcancel", (event) => end(event, true)],
    ["pointerdown", onPointerDown],
    ["pointermove", onPointerMove],
    ["pointerup", onPointerEnd],
    ["pointercancel", (event) => { if ((event as Pointery).pointerType !== "touch") end(event, true); }],
  ];
  for (const [type, listener, options] of listeners) sheet.addEventListener(type, listener, options);
  return () => {
    for (const [type, listener, options] of listeners) sheet.removeEventListener(type, listener, options);
    if (gesture?.tracking) {
      sheet.removeAttribute("data-dragging");
      drawSheetAt(sheet, scrim, 0);
    }
    gesture = null;
  };
}
