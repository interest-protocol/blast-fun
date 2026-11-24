/**
 * The phone sheet's pull-down and its exits, as numbers (OA-31, OA-28 M2):
 * the gate's version 5 `sheetDrag`, `springFrames` and `closeLayer`
 * (`design/blast-feel-preview-oa36.html`), with nothing of the DOM in it, so
 * every threshold, speed and frame is a test.
 *
 * - A press becomes a drag after 8 px of travel down (or up, from the
 *   handle), so a tap stays a tap; a sideways-dominant move belongs to a
 *   sideways scroller, and an upward move from the content scrolls it.
 * - The sheet tracks the finger 1:1 downward and rubber-bands above its
 *   resting place (`x·h·.55 / (h + .55x)`).
 * - On release the speed is read from the last ~100 ms of samples only, and
 *   is zero if the finger rested more than 60 ms before lifting; the landing
 *   is projected the way scrolling decelerates (`offset + (v/1000)·.998/(1−.998)`).
 * - Past half the sheet's height it closes at the finger's speed (at least
 *   600 px/s); otherwise a critically damped spring (response .34 s, never
 *   past rest on the way down) brings it home, sampled at 60 fps into
 *   keyframes that run on the compositor.
 *
 * The Blast-mode panel's phone sheet (`social/blast-mode/panel`) reads its
 * release speed (`velocityWindow`, `releaseVelocity`), projection and rubber
 * band from here too, with the gate's own `bxSheetDown` rules: its last six
 * moves, its 35 % close line and its CSS snap.
 */

import { EASE_DRAWER, EASE_OUT } from "./motion-tokens";

/** Travel before a press becomes a drag. */
export const SHEET_SLOP_PX = 8;
/** A press this close to the sheet's top edge is on its handle. */
export const SHEET_HANDLE_PX = 44;
/** The rubber band's share: `x·h·.55 / (h + .55x)`. */
export const SHEET_RUBBER = 0.55;
/** The momentum's per-millisecond decay (Apple's `UIScrollView.DecelerationRate.normal`). */
export const SHEET_DECAY = 0.998;
/** The release speed is read over this much of the gesture's end. */
export const SHEET_VELOCITY_WINDOW_MS = 100;
/** A finger still for longer than this before lifting has no speed left. */
export const SHEET_REST_MS = 60;
/** Past this share of its height, a released sheet closes. */
export const SHEET_CLOSE_SHARE = 0.5;
/** A sheet flung closed leaves at least this fast (px/s). */
export const SHEET_MIN_FLING_PX_S = 600;
/** The spring home: critically damped, this response (s). */
export const SHEET_SPRING_RESPONSE_S = 0.34;
/** The spring's keyframes are sampled at this rate. */
export const SHEET_SPRING_FPS = 60;
/** The scrim never fades below this while the sheet is pulled. */
export const SHEET_SCRIM_MIN = 0.25;

/** The eases and durations for the sheet's own motion (`openLayer`, `closeLayer`, `swapSheet`): the motion tokens. */
export const SHEET_EASE_OUT = EASE_OUT;
/** The strong ease-out (`--ease-std`): an exit moves at once and settles, never creeping out of rest. */
export const SHEET_EASE_STD = EASE_OUT;
export const SHEET_EASE_RISE = EASE_DRAWER;
/**
 * `cubic-bezier(.25,.75,.5,1)` leaves at 3× its average pace, so `3 × distance / speed` starts it at the finger's speed:
 * a physical curve, not a motion token.
 */
export const SHEET_EASE_FLING = "cubic-bezier(.25,.75,.5,1)";
export const SHEET_SCRIM_IN_MS = 180;
export const SHEET_RISE_MS = 200;
export const SHEET_POP_MS = 200;
export const SHEET_CLOSE_MS = 160;
export const SHEET_FLING_MIN_MS = 140;
export const SHEET_FLING_MAX_MS = 360;
/** Reduced motion: the scrim and the sheet fade in and out where they stand. */
export const SHEET_FADE_MS = 160;

/** One sample of the gesture: when (ms, the events' `timeStamp`) and where the sheet was drawn (px below rest). */
export type DragSample = readonly [timeMs: number, offset: number];

/** `x·h·.55 / (h + .55x)`: the further past rest, the less the sheet follows. */
export function rubberBand(over: number, height: number): number {
  return (over * height * SHEET_RUBBER) / (height + SHEET_RUBBER * over);
}

/** Where the sheet is drawn for a raw travel: 1:1 below rest, rubber-banded above it. */
export function dragOffset(raw: number, height: number): number {
  return raw < 0 ? -rubberBand(-raw, height) : raw;
}

/**
 * The samples a release speed is read from: each new one drops those more
 * than ~100 ms older than it, always keeping two.
 */
export class DragSamples {
  readonly #samples: DragSample[] = [];

  constructor(first?: DragSample) {
    if (first !== undefined) this.#samples.push(first);
  }

  get samples(): readonly DragSample[] {
    return this.#samples;
  }

  push(timeMs: number, offset: number): void {
    this.#samples.push([timeMs, offset]);
    while (this.#samples.length > 2 && timeMs - this.#samples[0]![0] > SHEET_VELOCITY_WINDOW_MS) this.#samples.shift();
  }

  /** px/s over the samples kept; zero when the finger rested longer than 60 ms before `releasedAt`. */
  velocity(releasedAt?: number): number {
    return releaseVelocity(this.#samples, releasedAt);
  }
}

/** The samples within ~100 ms of the newest, always keeping two (the gate's trim at release). */
export function velocityWindow(samples: readonly DragSample[]): readonly DragSample[] {
  let start = 0;
  while (samples.length - start > 2 && samples[samples.length - 1]![0] - samples[start]![0] > SHEET_VELOCITY_WINDOW_MS) start += 1;
  return samples.slice(start);
}

/** px/s from the oldest sample to the newest, or zero if the finger rested longer than 60 ms before `releasedAt` (when known). */
export function releaseVelocity(samples: readonly DragSample[], releasedAt?: number): number {
  const [t0, y0] = samples[0] ?? [0, 0];
  const [t1, y1] = samples[samples.length - 1] ?? [0, 0];
  const rested = releasedAt !== undefined && releasedAt - t1 > SHEET_REST_MS;
  return t1 > t0 && !rested ? ((y1 - y0) / (t1 - t0)) * 1_000 : 0;
}

/** Where the gesture was heading: `offset + (v/1000)·.998/(1−.998)` (Apple's projection). */
export function projectedRest(offset: number, velocityPxPerS: number): number {
  return offset + ((velocityPxPerS / 1_000) * SHEET_DECAY) / (1 - SHEET_DECAY);
}

/**
 * A critically damped spring (ζ = 1), `x(t) = (A + (v0 + ωA)t)·e^(−ωt)`,
 * from `from` px at `v0` px/s, sampled at 60 fps until it is within half a
 * pixel and 12 px/s of rest, then rest. Coming down to rest it never passes
 * it: lifting a bottom sheet would open a gap under it.
 */
export function springFrames(from: number, v0: number, response = SHEET_SPRING_RESPONSE_S): number[] {
  const w = (2 * Math.PI) / response;
  const a = from;
  const b = v0 + w * a;
  const frames: number[] = [];
  for (let t = 0; t < 2; t += 1 / SHEET_SPRING_FPS) {
    const e = Math.exp(-w * t);
    const x = (a + b * t) * e;
    const v = (b - w * (a + b * t)) * e;
    frames.push(a >= 0 ? Math.max(0, x) : x);
    if (Math.abs(x) < 0.5 && Math.abs(v) < 12) break;
  }
  frames.push(0);
  return frames;
}

/** How long the spring's keyframes play: one 60 fps frame between each. */
export function springDurationMs(frames: readonly number[]): number {
  return (frames.length - 1) / (SHEET_SPRING_FPS / 1_000);
}

/** The scrim's opacity with the sheet `offset` px below rest: it fades as the sheet goes, never below .25. */
export function scrimOpacity(offset: number, height: number): number {
  return Math.max(SHEET_SCRIM_MIN, 1 - Math.max(0, offset) / height);
}

/** The exit's timing: at the finger's speed after a fling, else the standard 220 ms close. */
export function exitTiming(fling: number, height: number, from: number, phone: boolean): Readonly<{ durationMs: number; easing: string }> {
  if (phone && fling > 0) {
    return {
      durationMs: Math.min(SHEET_FLING_MAX_MS, Math.max(SHEET_FLING_MIN_MS, ((3 * (height - from)) / fling) * 1_000)),
      easing: SHEET_EASE_FLING,
    };
  }
  return { durationMs: SHEET_CLOSE_MS, easing: SHEET_EASE_STD };
}

/** What a release does: close at the fling's speed, or spring home from where it is. */
export type DragRelease =
  | Readonly<{ kind: "close"; offset: number; velocity: number; fling: number }>
  | Readonly<{ kind: "home"; offset: number; velocity: number; frames: readonly number[]; durationMs: number }>;

/** The spring home from `offset` px at `velocity` px/s. */
export function springHome(offset: number, velocity: number): Extract<DragRelease, { kind: "home" }> {
  const frames = springFrames(offset, velocity);
  return { kind: "home", offset, velocity, frames, durationMs: springDurationMs(frames) };
}

/** Settles a release at `offset` moving at `velocity`: past `closeShare` of the height it closes, else it springs home. */
export function settleRelease(offset: number, velocity: number, height: number, closeShare = SHEET_CLOSE_SHARE): DragRelease {
  if (projectedRest(offset, velocity) > height * closeShare) {
    return { kind: "close", offset, velocity, fling: Math.max(velocity, SHEET_MIN_FLING_PX_S) };
  }
  return springHome(offset, velocity);
}

/** What a move did to the gesture. */
export type DragStep =
  /** Still within the slop: nothing moves yet. */
  | Readonly<{ kind: "wait" }>
  /** Not the sheet's: a sideways scroller's, the content scrolling up, or a closing sheet. The gesture is over. */
  | Readonly<{ kind: "cancel" }>
  /** The sheet is drawn at `offset`; `started` on the move that caught it. */
  | Readonly<{ kind: "track"; offset: number; started: boolean }>;

/** What the gesture reads from the sheet when it catches it. */
export type DragCatch = Readonly<{
  /** The sheet is already on its way out: it cannot be caught. */
  closing: () => boolean;
  /** Its live position (px below rest), mid-open or mid-spring included. */
  base: () => number;
  /** Its height (px). */
  height: () => number;
}>;

/**
 * One press on the sheet, from the first contact to the release. The DOM
 * half (`sheet-gesture.ts`) decides where a press may start and draws what
 * this answers.
 */
export class SheetDragGesture {
  /** Pressed within the top 44 px: the handle, which may also pull up and is the only place a mouse may pull. */
  readonly handle: boolean;
  #x0: number;
  #y0: number;
  #on = false;
  #over = false;
  #base = 0;
  #offset = 0;
  readonly #samples = new DragSamples();

  constructor(x: number, y: number, handle: boolean) {
    this.#x0 = x;
    this.#y0 = y;
    this.handle = handle;
  }

  /** The press became a drag. */
  get tracking(): boolean {
    return this.#on;
  }

  get offset(): number {
    return this.#offset;
  }

  get samples(): readonly DragSample[] {
    return this.#samples.samples;
  }

  move(x: number, y: number, timeMs: number, sheet: DragCatch): DragStep {
    if (this.#over) return { kind: "cancel" };
    let started = false;
    if (!this.#on) {
      const dx = x - this.#x0;
      const dy = y - this.#y0;
      if (Math.abs(dx) > SHEET_SLOP_PX && Math.abs(dx) > Math.abs(dy)) return this.#cancel();
      if (dy < -SHEET_SLOP_PX && !this.handle) return this.#cancel();
      if (Math.abs(dy) < SHEET_SLOP_PX) return { kind: "wait" };
      if (sheet.closing()) return this.#cancel();
      // Caught wherever it is, and tracked from here, so it does not jump by the slop.
      const base = sheet.base();
      const height = sheet.height();
      // The live value is already rubber-banded; invert it before applying new travel.
      this.#base = base < 0 && base > -height ? base * height / (SHEET_RUBBER * (height + base)) : base;
      this.#on = true;
      this.#y0 = y;
      started = true;
    }
    this.#offset = dragOffset(this.#base + (y - this.#y0), sheet.height());
    this.#samples.push(timeMs, this.#offset);
    return { kind: "track", offset: this.#offset, started };
  }

  /** The finger lifted (at `releasedAt`, when known) or the gesture was cancelled: null if it never became a drag. */
  release(releasedAt: number | undefined, height: number): DragRelease | null {
    const on = this.#on;
    this.#over = true;
    this.#on = false;
    if (!on) return null;
    return settleRelease(this.#offset, this.#samples.velocity(releasedAt), height);
  }

  #cancel(): DragStep {
    this.#over = true;
    return { kind: "cancel" };
  }
}
