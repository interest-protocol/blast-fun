import assert from "node:assert/strict";
import test from "node:test";

import { cardFrame, liveFrame, restFrame } from "./expand-motion";

const page = { left: 0, top: 0, width: 1440, height: 900 };

test("the full-page chart starts drawn over its card: scaled uniformly from its corner, clipped to the card", () => {
  // A card wider than the page's shape: the width decides the scale, and the clip crops the height.
  const card = { left: 300, top: 120, width: 720, height: 360 };
  const frame = cardFrame(card, page, 22, 0.9);
  assert.equal(frame.transform, "translate(300px, 120px) scale(0.5)");
  assert.equal(frame.clipPath, "inset(0px 0px 180px 0px round 44px)");
  assert.equal(frame.opacity, 0.9);
  // Drawn: 1440 × 0.5 = 720 wide; (900 − 180) × 0.5 = 360 tall; corners 44 × 0.5 = 22, the card's.
});

test("a tall card: the height decides the scale and the clip crops the width; no axis is stretched", () => {
  const frame = cardFrame({ left: 40, top: 80, width: 300, height: 450 }, page, 0, 1);
  assert.equal(frame.transform, "translate(40px, 80px) scale(0.5)");
  assert.equal(frame.clipPath, "inset(0px 840px 0px 0px round 0px)");
  assert.doesNotMatch(frame.transform, /scale\([^)]*,/, "one scale for both axes");
});

test("a fixed panel below the header maps the same way, relative to where it is laid out", () => {
  const frame = cardFrame({ left: 312, top: 140, width: 560, height: 350 }, { left: 24, top: 72, width: 1392, height: 808 }, 22, 0.9);
  const scale = Math.max(560 / 1392, 350 / 808);
  assert.equal(frame.transform, `translate(288px, 68px) scale(${scale})`);
});

test("a motion caught mid-way continues from where the element is drawn", () => {
  const rest = restFrame(0);
  const live = liveFrame({ transform: "matrix(0.75, 0, 0, 0.75, 150, 60)", clipPath: "inset(0px 0px 90px 0px round 29.3px)", opacity: "0.95" }, rest);
  assert.deepEqual(live, { transform: "translate(150px, 60px) scale(0.75)", clipPath: "inset(0px 0px 90px 0px round 29.3px)", opacity: 0.95 });
  assert.deepEqual(liveFrame({ transform: "none", clipPath: "none", opacity: "1" }, rest), rest, "at rest, the rest frame");
});
