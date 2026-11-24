import assert from "node:assert/strict";
import test from "node:test";

import {
  ballFlight,
  ballScale,
  ballShake,
  barLandingPoint,
  canStartHold,
  centreOf,
  FEEL_BALL_FLIGHT_EASING,
  FEEL_BALL_FLIGHT_MS,
  FEEL_BALL_LANDING_SCALE,
  FEEL_BALL_SHAKE_MS,
  FEEL_BAR_INSET_PX,
  FEEL_HOLD_AMOUNTS_USD,
  FEEL_HOLD_ARM_MS,
  FEEL_HOLD_CANCEL_PX,
  FEEL_HOLD_STEP_MS,
  flightLift,
  holdAmountUsd,
  holdCancelled,
  nextHoldLevel,
} from "./feel-hold.ts";

/**
 * OA-23 / FEEL-LAYER.md §2: hold to blast. Every number here was read off the
 * gate in Chrome: the charge arming at 220 ms, stepping every 650 ms, stopping
 * at $500 with $860 of USDC, cancelling past 40 px, and the ball's measured
 * three-keyframe flight.
 */

test("the ladder, the thresholds and the cancel radius are the gate's", () => {
  assert.deepEqual(FEEL_HOLD_AMOUNTS_USD, [50, 100, 500, 1000]);
  assert.equal(FEEL_HOLD_ARM_MS, 220);
  assert.equal(FEEL_HOLD_STEP_MS, 650);
  assert.equal(FEEL_HOLD_CANCEL_PX, 40);
});

test("the charge climbs the ladder and never past the viewer's USDC", () => {
  // Measured with USDC 860: $50 at 220 ms, $100 at ~870 ms, $500 at ~1520 ms,
  // and still $500 at 3.6 s — $1,000 is never reached.
  const usdc = 860;
  assert.equal(nextHoldLevel(0, usdc), 1);
  assert.equal(nextHoldLevel(1, usdc), 2);
  assert.equal(nextHoldLevel(2, usdc), null, "$1,000 is more than $860");
  assert.deepEqual([0, 1, 2, 3].map((level) => holdAmountUsd(level)), [50, 100, 500, 1000]);
  // The whole ladder, for somebody who can afford it.
  assert.equal(nextHoldLevel(2, 1000), 3);
  assert.equal(nextHoldLevel(3, 1_000_000), null, "the ladder ends at $1,000");
});

test("a charge does not start at all below the first rung", () => {
  assert.equal(canStartHold(50), true);
  assert.equal(canStartHold(49.99), false, "the press stays a plain press");
  assert.equal(canStartHold(0), false);
  assert.equal(nextHoldLevel(0, 0), null);
});

test("the amount is clamped, so no level can read off the end of the ladder", () => {
  assert.equal(holdAmountUsd(-1), 50);
  assert.equal(holdAmountUsd(99), 1000);
  assert.equal(holdAmountUsd(1, [25, 75]), 75);
});

test("dragging more than 40 px calls the charge off; 40 px and under does not", () => {
  // Measured: still charging at 30 px, cancelled at 41 px.
  assert.equal(holdCancelled(30, 0), false);
  assert.equal(holdCancelled(40, 0), false, "exactly 40 px is still a hold");
  assert.equal(holdCancelled(41, 0), true);
  assert.equal(holdCancelled(0, -41), true, "in any direction");
  assert.equal(holdCancelled(29, 29), true, "the radius is the distance, not an axis");
  assert.equal(holdCancelled(28, 28), false);
});

test("the ball grows a step with each amount", () => {
  // Measured: --s 1.28 after two steps, 1.14 after one.
  assert.equal(ballScale(0), 1);
  assert.equal(ballScale(1), 1.14);
  assert.equal(ballScale(2), 1.28);
  assert.equal(ballScale(3), 1.42);
});

test("the ball lands at the raise's own fill, inset from either end of the bar", () => {
  const bar = { left: 1200, top: 436, width: 180, height: 20 } as const;
  const half = barLandingPoint(bar, 50, 100);
  assert.equal(half.x, 1200 + 90);
  assert.equal(half.y, 446, "the bar's vertical middle");
  // An empty raise still lands on the bar, not on its rounding.
  assert.equal(barLandingPoint(bar, 0, 100).x, 1200 + FEEL_BAR_INSET_PX);
  // An oversubscribed raise lands inside the far end.
  assert.equal(barLandingPoint(bar, 400, 100).x, 1200 + 180 - FEEL_BAR_INSET_PX);
  // A sale with no target does not divide by zero.
  assert.equal(barLandingPoint(bar, 10, 0).x, 1200 + FEEL_BAR_INSET_PX);
});

test("the arc rises over the higher of its ends, capped at 70 px", () => {
  assert.equal(flightLift({ x: 0, y: 100 }, { x: 0, y: 110 }), 50, "10 px apart: 40 + 10");
  assert.equal(flightLift({ x: 0, y: 100 }, { x: 0, y: 400 }), 70, "far apart: capped");
  assert.equal(flightLift({ x: 0, y: 100 }, { x: 0, y: 100 }), 40, "level: the base lift");
});

test("the flight is the gate's version-5 keyframes: transform only, translated along the arc", () => {
  // Measured instance: a 95.5625 x 40 button at (861.4375, 332.859375), level 2,
  // landing at (1244.483136, 446.125). The gate's v5 (`mx`/`my`): the ball stays at
  // the button's centre in layout and is translated half the way across and up to
  // the crest (`min(y0, y1) − lift − y0`), then by the whole distance.
  const button = { left: 861.4375, top: 332.859375, width: 95.5625, height: 40 } as const;
  const from = centreOf(button);
  assert.deepEqual(from, { x: 909.21875, y: 352.859375 });
  const to = { x: 1244.483136, y: 446.125 } as const;
  const flight = ballFlight(from, to, ballScale(2));
  assert.deepEqual(flight.options, { duration: FEEL_BALL_FLIGHT_MS, easing: FEEL_BALL_FLIGHT_EASING, fill: "forwards" });
  assert.equal(FEEL_BALL_FLIGHT_MS, 460);
  assert.equal(FEEL_BALL_FLIGHT_EASING, "cubic-bezier(.3, 0, .2, 1)");
  const mx = (to.x - from.x) / 2;
  const my = Math.min(from.y, to.y) - flightLift(from, to) - from.y;
  assert.equal(my, -70, "up to the crest: 70 px over the button (the lift's cap)");
  assert.deepEqual(flight.keyframes, [
    { transform: "translate(-50%, -50%) scale(1.28)" },
    { transform: `translate(-50%, -50%) translate(${mx}px, -70px) scale(1.15)`, offset: 0.5 },
    { transform: `translate(-50%, -50%) translate(${to.x - from.x}px, 93.265625px) scale(${FEEL_BALL_LANDING_SCALE})` },
  ]);
  assert.equal(flight.keyframes[1]!.transform, "translate(-50%, -50%) translate(167.63219300000003px, -70px) scale(1.15)");
});

test("OA-31 v5: every keyframe of the flight and the shake animates transform alone (the compositor's property)", () => {
  const flight = ballFlight({ x: 100, y: 400 }, { x: 640, y: 120 }, ballScale(5));
  for (const keyframes of [flight.keyframes, ballShake().keyframes]) {
    for (const frame of keyframes) {
      const animated = Object.keys(frame).filter((key) => key !== "offset" && key !== "easing" && key !== "composite");
      assert.deepEqual(animated, ["transform"], JSON.stringify(frame));
    }
  }
  // Rising to a bar above the button: the crest is over the bar, 70 px higher (the lift is capped).
  assert.match(String(flight.keyframes[1]!.transform), /^translate\(-50%, -50%\) translate\(270px, -350px\) scale\(1\.53\)$/);
  assert.match(String(flight.keyframes[2]!.transform), /^translate\(-50%, -50%\) translate\(540px, -280px\) scale\(0\.35\)$/);
});

test("a refused quote shakes the ball where it stands instead of flying it", () => {
  const shake = ballShake();
  assert.equal(shake.options.duration, FEEL_BALL_SHAKE_MS);
  assert.equal(FEEL_BALL_SHAKE_MS, 220);
  assert.deepEqual(shake.keyframes.map((frame) => frame.transform), [
    "translate(-50%, -50%) translateX(0px)",
    "translate(-50%, -50%) translateX(-6px)",
    "translate(-50%, -50%) translateX(6px)",
    "translate(-50%, -50%) translateX(0px)",
  ]);
  for (const frame of shake.keyframes) {
    assert.equal(frame.left, undefined, "a shake never moves the ball off the button");
    assert.equal(frame.top, undefined);
  }
});
