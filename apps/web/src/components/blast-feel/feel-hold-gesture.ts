/**
 * Hold to blast, as a state machine (R3-13).
 *
 * The press, the charge, the cancel paths and the release, with no DOM and no
 * React: every event arrives through an injected target and every timer
 * through an injected scope, so each path is a test. `use-feel-hold.ts` drives
 * it from a button; `feel-hold.ts` holds the numbers.
 *
 * What it keeps that the gate's lab does not (R3-13's "defects and hazards"):
 *
 *  - **One stable node.** Move, up, cancel, Escape, a lost pointer capture and
 *    the window losing focus are all heard on the window (`events`), which
 *    outlives the button, so a re-render or a failed `setPointerCapture`
 *    cannot strand a charge. `lostpointercapture` is a cancel, as the
 *    contract asks, and so is another element taking the pointer's capture
 *    (`gotpointercapture` outside the button): whatever captures the pointer
 *    owns the gesture, for a mouse as for a touch.
 *  - **The pointer that pressed.** Only events from the press's own pointer id
 *    move, release or cancel it; a second finger does nothing to it.
 *  - **The click it swallows is its own.** A charged release swallows the next
 *    click inside the pressed button, and only from the same pointer (a click
 *    from another pointer, or anywhere else, goes through), and gives up after
 *    `FEEL_SWALLOW_CLICK_MS`.
 *  - **No path leaves the button charged.** Release, every cancel and
 *    `dispose` all end in `onCharge(null)` when a charge was showing.
 *  - **The ladder never guesses.** It climbs only while the next amount is
 *    covered by what the viewer can spend *now* (`availableUsd`, read at every
 *    step from the wallet's real read); while that read has not answered it
 *    waits on the first rung instead of climbing on a guess.
 */

import type { FeelSignal } from "./feel-cues.ts";
import {
  FEEL_HOLD_AMOUNTS_USD,
  FEEL_HOLD_ARM_MS,
  FEEL_HOLD_STEP_MS,
  FEEL_SWALLOW_CLICK_MS,
  holdAmountUsd,
  holdCancelled,
  nextHoldLevel,
} from "./feel-hold.ts";
import type { FeelEventTarget, FeelScope } from "./feel-scope.ts";

export type HoldCancelReason = "drag" | "escape" | "pointercancel" | "lostpointercapture" | "captured" | "blur" | "replaced" | "disposed";

/** How a press ended: a quick tap (the button's own click runs), a charged release, or a cancel. */
export type HoldOutcome = "tap" | "released" | "unaffordable" | HoldCancelReason;

export type HoldRelease = Readonly<{ level: number; amountUsd: number }>;

/**
 * Where the gesture's timers and listeners live: the Feel layer's `FeelScope`,
 * or — inside Blast mode — the mode's own task registry (R3-60's
 * `BlastTasks`, through `holdScopeOnTasks`), so they stop with the mode.
 */
export type HoldScope = Pick<FeelScope, "after" | "clear" | "on">;

/** The slice of a timer registry the gesture needs. R3-60's `BlastTasks` satisfies it. */
export type HoldTimers = Readonly<{
  after: (run: () => void, ms: number) => number;
  clear: (handle: number | null | undefined) => void;
  on: (target: EventTarget, type: string, listener: (event: Event) => void, options?: AddEventListenerOptions) => () => void;
}>;

/**
 * A registry as the gesture's scope. Listeners default to the capture phase,
 * as the Feel layer's own scope does: the release's click must be caught
 * before the page's handler runs.
 */
export function holdScopeOnTasks(tasks: HoldTimers): HoldScope {
  return {
    after: (handler, ms) => tasks.after(handler, ms),
    clear: (id) => tasks.clear(id),
    on: (target, type, listener, options = { capture: true }) =>
      tasks.on(target as EventTarget, type, listener as unknown as (event: Event) => void, options),
  };
}

export type HoldGestureHost = Readonly<{
  scope: HoldScope;
  /** Where the press is followed: the window, which outlives the button. */
  events: FeelEventTarget;
  /** Where the release's click is caught, in the capture phase: the document. */
  clicks: FeelEventTarget;
  play: (signal: FeelSignal) => void;
  /** What the viewer can spend now, in dollars; null while the wallet's read has not answered. */
  availableUsd: () => number | null;
  amounts?: readonly number[];
  /** The charge as it shows: a level while charging, null once it ends. */
  onCharge: (level: number | null) => void;
  /** A charged release: the caller quotes, flies the ball and commits. */
  onRelease: (release: HoldRelease) => void;
  /** How the press ended. */
  onEnd?: (outcome: HoldOutcome) => void;
}>;

export type HoldPress = Readonly<{
  pointerId: number;
  x: number;
  y: number;
  /** Whether a node is inside the pressed button: the click to swallow lands there. */
  contains: (node: unknown) => boolean;
}>;

/** The slice of an event the gesture reads. */
type Heard = Readonly<{
  pointerId?: unknown;
  clientX?: unknown;
  clientY?: unknown;
  key?: unknown;
  target?: unknown;
  stopPropagation?: () => void;
  preventDefault?: () => void;
}>;

type Active = HoldPress & {
  level: number;
  armed: boolean;
  over: boolean;
  timer: number;
  detach: (() => void)[];
};

const coordinate = (value: unknown, fallback: number) => (typeof value === "number" && Number.isFinite(value) ? value : fallback);

export class FeelHoldGesture {
  readonly #host: HoldGestureHost;
  #active: Active | null = null;

  constructor(host: HoldGestureHost) {
    this.#host = host;
  }

  /** `idle` between presses, `pressed` before the charge arms, `charging` once it has. */
  get phase(): "idle" | "pressed" | "charging" {
    const active = this.#active;
    if (!active) return "idle";
    return active.armed ? "charging" : "pressed";
  }

  /** The charge's rung while charging, else null. */
  get level(): number | null {
    return this.#active?.armed ? this.#active.level : null;
  }

  #amounts(): readonly number[] {
    return this.#host.amounts ?? FEEL_HOLD_AMOUNTS_USD;
  }

  /** A primary press on the button. A press already held is called off first. */
  press(press: HoldPress): void {
    if (this.#active) this.#cancel(this.#active, "replaced");
    const active: Active = { ...press, level: 0, armed: false, over: false, timer: 0, detach: [] };
    this.#active = active;
    const { scope, events } = this.#host;
    // Only the pointer that pressed moves, releases or cancels it.
    const mine = (event: Heard) => typeof event.pointerId !== "number" || event.pointerId === active.pointerId;
    active.detach.push(
      scope.on<Heard>(events, "pointermove", (event) => {
        if (active.over || !mine(event)) return;
        const dx = coordinate(event.clientX, active.x) - active.x;
        const dy = coordinate(event.clientY, active.y) - active.y;
        if (holdCancelled(dx, dy)) this.#cancel(active, "drag");
      }),
      scope.on<Heard>(events, "pointerup", (event) => {
        if (mine(event)) this.#release(active);
      }),
      scope.on<Heard>(events, "pointercancel", (event) => {
        if (mine(event)) this.#cancel(active, "pointercancel");
      }),
      scope.on<Heard>(events, "lostpointercapture", (event) => {
        if (mine(event)) this.#cancel(active, "lostpointercapture");
      }),
      // Another element taking the pointer takes the press: a swipe or a drag around the button (Today on
      // Blast's stage once it tracks). A touch held the button's implicit capture, so it hears that as
      // `lostpointercapture` above; a mouse holds none, so its only sign is `gotpointercapture` on the element
      // that took it. The button's own capture (a touch's implicit one lands inside it) changes nothing.
      scope.on<Heard>(events, "gotpointercapture", (event) => {
        if (mine(event) && !active.contains(event.target)) this.#cancel(active, "captured");
      }),
      // Escape calls it off. Not prevented and not stopped: whatever else Escape closes still closes.
      scope.on<Heard>(events, "keydown", (event) => {
        if (event.key === "Escape") this.#cancel(active, "escape");
      }),
      // The window losing focus (another app, a system sheet): the pointer is lost. A blur of an
      // element inside the page also passes a capture listener here, so only the window's own counts.
      scope.on<Heard>(events, "blur", (event) => {
        if (event.target === events) this.#cancel(active, "blur");
      }),
    );
    active.timer = scope.after(() => this.#arm(active), FEEL_HOLD_ARM_MS);
  }

  /** Calls off whatever is held. Safe at any time; the surface unmounting calls it. */
  dispose(): void {
    if (this.#active) this.#cancel(this.#active, "disposed");
  }

  #arm(active: Active): void {
    if (active.over) return;
    const available = this.#host.availableUsd();
    const first = this.#amounts()[0];
    // A wallet known not to cover the first rung never charges: the press stays a press.
    if (available !== null && (first === undefined || first > available)) {
      this.#end(active, "unaffordable");
      return;
    }
    active.armed = true;
    active.level = 0;
    this.#host.onCharge(0);
    this.#host.play({ kind: "tick", level: 0 });
    active.timer = this.#host.scope.after(() => this.#step(active), FEEL_HOLD_STEP_MS);
  }

  #step(active: Active): void {
    if (active.over || !active.armed) return;
    const available = this.#host.availableUsd();
    if (available === null) {
      // The wallet has not answered yet: wait on this rung and look again, never climb on a guess.
      active.timer = this.#host.scope.after(() => this.#step(active), FEEL_HOLD_STEP_MS);
      return;
    }
    const next = nextHoldLevel(active.level, available, this.#amounts());
    if (next === null) return;
    active.level = next;
    this.#host.onCharge(next);
    this.#host.play({ kind: "tick", level: next });
    active.timer = this.#host.scope.after(() => this.#step(active), FEEL_HOLD_STEP_MS);
  }

  #release(active: Active): void {
    if (active.over) return;
    if (!active.armed) {
      // A quick tap: the button's own click runs, untouched.
      this.#end(active, "tap");
      return;
    }
    const level = active.level;
    this.#swallowClick(active);
    this.#end(active, "released");
    this.#host.onRelease({ level, amountUsd: holdAmountUsd(level, this.#amounts()) });
  }

  #cancel(active: Active, reason: HoldCancelReason): void {
    if (active.over) return;
    this.#end(active, reason);
  }

  /** The one way out: timers and listeners off, the charge reverted, the outcome reported. */
  #end(active: Active, outcome: HoldOutcome): void {
    active.over = true;
    this.#host.scope.clear(active.timer);
    for (const off of active.detach) off();
    active.detach.length = 0;
    if (this.#active === active) this.#active = null;
    if (active.armed) this.#host.onCharge(null);
    this.#host.onEnd?.(outcome);
  }

  /**
   * The click this release produces would run the button's own action (open
   * the dialog, arm the card) on top of the commit: swallow exactly that one —
   * inside the button, from the same pointer — and give up after
   * `FEEL_SWALLOW_CLICK_MS` so a click that never comes cannot wedge it. A
   * keyboard-made click (no positive pointer id) inside the button in that
   * window is the same press finishing, and is swallowed too.
   */
  #swallowClick(active: Active): void {
    const { scope, clicks } = this.#host;
    const off = scope.on<Heard>(clicks, "click", (event) => {
      if (!active.contains(event.target)) return;
      const id = event.pointerId;
      if (typeof id === "number" && id > 0 && id !== active.pointerId) return;
      event.stopPropagation?.();
      event.preventDefault?.();
      off();
    });
    scope.after(off, FEEL_SWALLOW_CLICK_MS);
  }
}
