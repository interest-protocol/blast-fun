/**
 * Hold to blast, as arithmetic (FEEL-LAYER.md §2).
 *
 * Hold a Blast button and it charges: $50 → $100 → $500 → $1,000, never past
 * the viewer's USDC, one rising tick and one step of pink glow each. Let go and
 * a small ball springs out of the button and arcs into that sale's bar.
 *
 * Every threshold, every easing and the flight's three keyframes live here as
 * pure functions, so the hold is testable without a browser and the gate's
 * numbers are in one readable place. `use-feel-hold.ts` drives them from React;
 * `feel-ball.ts` paints them.
 */

/** The ladder, in whole dollars. */
export const FEEL_HOLD_AMOUNTS_USD: readonly number[] = [50, 100, 500, 1000];
/** How long a press must last before the charge begins. */
export const FEEL_HOLD_ARM_MS = 220;
/** How long each amount holds before the next. */
export const FEEL_HOLD_STEP_MS = 650;
/** Drag further than this from the press point and the charge is off. */
export const FEEL_HOLD_CANCEL_PX = 40;
/** How much bigger the ball gets per step. */
export const FEEL_BALL_SCALE_PER_LEVEL = 0.14;
/** The flight. */
export const FEEL_BALL_FLIGHT_MS = 460;
export const FEEL_BALL_FLIGHT_EASING = "cubic-bezier(.3, 0, .2, 1)";
/** The arc's height over the higher of its two ends, capped. */
export const FEEL_BALL_LIFT_MAX_PX = 70;
export const FEEL_BALL_LIFT_BASE_PX = 40;
/** The ball shrinks to this as it lands. */
export const FEEL_BALL_LANDING_SCALE = 0.35;
/** The shake when the quote comes back an error, instead of a flight. */
export const FEEL_BALL_SHAKE_MS = 220;
export const FEEL_BALL_SHAKE_PX = 6;
/** How long after the shake the ball leaves. */
export const FEEL_BALL_SHAKE_EXIT_MS = 240;
/** The ball never lands closer than this to either end of the bar. */
export const FEEL_BAR_INSET_PX = 6;
/** The one-shot click swallow gives up after this, so a missing click cannot wedge it. */
export const FEEL_SWALLOW_CLICK_MS = 400;

/**
 * The next level, or null when the charge has gone as far as it can: the ladder
 * has run out, or the next amount is more than the viewer holds.
 */
export function nextHoldLevel(level: number, availableUsd: number, amounts: readonly number[] = FEEL_HOLD_AMOUNTS_USD): number | null {
  const next = level + 1;
  if (next >= amounts.length) return null;
  const amount = amounts[next];
  if (amount === undefined || amount > availableUsd) return null;
  return next;
}

/** The amount a level stands for; the first rung when the level is out of range. */
export function holdAmountUsd(level: number, amounts: readonly number[] = FEEL_HOLD_AMOUNTS_USD): number {
  return amounts[Math.min(Math.max(level, 0), amounts.length - 1)] ?? 0;
}

/**
 * Whether a charge may start at all: the first rung has to be affordable. Below
 * it the press stays a plain press and the button keeps its own behaviour.
 */
export function canStartHold(availableUsd: number, amounts: readonly number[] = FEEL_HOLD_AMOUNTS_USD): boolean {
  const first = amounts[0];
  return first !== undefined && first <= availableUsd;
}

/** Dragged far enough from the press point to call it off. */
export function holdCancelled(dx: number, dy: number, radiusPx: number = FEEL_HOLD_CANCEL_PX): boolean {
  return Math.hypot(dx, dy) > radiusPx;
}

/** The ball's scale at a level, to two decimals as the gate writes it. */
export function ballScale(level: number): number {
  return Number((1 + level * FEEL_BALL_SCALE_PER_LEVEL).toFixed(2));
}

export type FeelPoint = Readonly<{ x: number; y: number }>;
export type FeelRect = Readonly<{ left: number; top: number; width: number; height: number }>;

/** The centre of a rect: where the ball springs from, and the bar's vertical middle. */
export function centreOf(rect: FeelRect): FeelPoint {
  return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
}

/**
 * Where on a sale's bar the money lands: at the raise's own fill, clamped
 * `FEEL_BAR_INSET_PX` from either end so it is never on the rounding.
 */
export function barLandingPoint(bar: FeelRect, raised: number, target: number): FeelPoint {
  const fill = target > 0 ? Math.min(1, raised / target) : 0;
  const along = Math.min(bar.width - FEEL_BAR_INSET_PX, Math.max(FEEL_BAR_INSET_PX, bar.width * fill));
  return { x: bar.left + along, y: bar.top + bar.height / 2 };
}

/** How high the arc rises over the higher of its two ends. */
export function flightLift(from: FeelPoint, to: FeelPoint): number {
  return Math.min(FEEL_BALL_LIFT_MAX_PX, Math.abs(to.y - from.y) + FEEL_BALL_LIFT_BASE_PX);
}

/** Exactly what `Element.animate` takes, so the geometry is the animation. */
export type FeelFlight = Readonly<{ keyframes: readonly Keyframe[]; options: KeyframeAnimationOptions }>;

/**
 * The flight: out of the button, up over the arc's crest at the halfway point,
 * down into the bar at a third of its size.
 *
 * It animates `transform` only (OA-31, the gate's version 5): the ball stays
 * where it was placed in layout (`left`/`top` at the button's centre, set once
 * when it is created) and is translated along the arc, so the whole flight runs
 * on the compositor. The translations are the gate's `mx`/`my` — half the way
 * across and up to the crest — and then the full distance to the landing.
 */
export function ballFlight(from: FeelPoint, to: FeelPoint, scale: number): FeelFlight {
  const lift = flightLift(from, to);
  const mx = (to.x - from.x) / 2;
  const my = Math.min(from.y, to.y) - lift - from.y;
  return {
    // The gate's three transform lists, function for function (their interpolation depends on it).
    keyframes: [
      { transform: `translate(-50%, -50%) scale(${scale})` },
      { transform: `translate(-50%, -50%) translate(${mx}px, ${my}px) scale(${Number((scale * 0.9).toFixed(2))})`, offset: 0.5 },
      { transform: `translate(-50%, -50%) translate(${to.x - from.x}px, ${to.y - from.y}px) scale(${FEEL_BALL_LANDING_SCALE})` },
    ],
    options: { duration: FEEL_BALL_FLIGHT_MS, easing: FEEL_BALL_FLIGHT_EASING, fill: "forwards" },
  };
}

/** The shake that stands in for the flight when the quote is refused. */
export function ballShake(): FeelFlight {
  const at = (x: number) => `translate(-50%, -50%) translateX(${x}px)`;
  return {
    keyframes: [{ transform: at(0) }, { transform: at(-FEEL_BALL_SHAKE_PX) }, { transform: at(FEEL_BALL_SHAKE_PX) }, { transform: at(0) }],
    options: { duration: FEEL_BALL_SHAKE_MS, easing: "linear" },
  };
}
