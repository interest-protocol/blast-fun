import assert from "node:assert/strict";
import test from "node:test";

import {
  DragSamples,
  dragOffset,
  exitTiming,
  projectedRest,
  releaseVelocity,
  rubberBand,
  scrimOpacity,
  settleRelease,
  SheetDragGesture,
  springDurationMs,
  springFrames,
  springHome,
  velocityWindow,
  type DragCatch,
  type DragStep,
} from "./sheet-gesture-model";

/**
 * OA-31 / OA-28 M2: the phone sheet's pull-down is the gate's version 5
 * (`design/blast-feel-preview-oa36.html`, `sheetDrag`, `springFrames`,
 * `closeLayer`), exactly. The gate's own functions are copied below,
 * character for character, as the oracle the model is measured against.
 */

/* ---------------- the gate, verbatim ---------------- */
function gateSpringFrames(from: number, v0: number, response = .34) {
  const w = 2 * Math.PI / response, A = from, B = v0 + w * A, f: number[] = [];
  for (let t = 0; t < 2; t += 1 / 60) {
    const e = Math.exp(-w * t), x = (A + B * t) * e, v = (B - w * (A + B * t)) * e;
    f.push(A >= 0 ? Math.max(0, x) : x); // coming down to rest it never passes it: lifting a bottom sheet would open a gap under it
    if (Math.abs(x) < .5 && Math.abs(v) < 12) break;
  }
  f.push(0); return f;
}
const gateRub = (x: number, h: number) => (x * h * .55) / (h + .55 * x);
/** `end`'s speed and landing, as the gate computes them from `d.pts` and the release event. */
function gateRelease(pts: [number, number][], y: number, releasedAt: number | undefined) {
  const [t0, y0] = pts[0] || [0, 0], [t1, y1] = pts[pts.length - 1] || [0, 0], v = t1 > t0 && !(releasedAt !== undefined && releasedAt - t1 > 60) ? (y1 - y0) / (t1 - t0) * 1000 : 0;
  const rest = y + (v / 1000) * .998 / (1 - .998);
  return { v, rest };
}
/** `closeLayer`'s duration and easing. */
const gateExit = (phone: boolean, v: number, h: number, y0: number) => ({
  dur: phone && v > 0 ? Math.min(360, Math.max(140, 3 * (h - y0) / v * 1000)) : 160,
  ease: phone && v > 0 ? 'cubic-bezier(.25,.75,.5,1)' : 'cubic-bezier(.23,1,.32,1)',
});

const H = 640;

test("OA-31: the rubber band is the gate's `x·h·.55/(h+.55x)`, and below rest the sheet follows 1:1", () => {
  for (const x of [0, 1, 8, 40, 120, 400, 1_000]) {
    for (const h of [320, 640, 844]) assert.equal(rubberBand(x, h), gateRub(x, h), `${x} over a ${h} px sheet`);
  }
  assert.equal(dragOffset(120, H), 120);
  assert.equal(dragOffset(0, H), 0);
  assert.equal(dragOffset(-100, H), -gateRub(100, H));
  assert.ok(dragOffset(-100, H) > -100 && dragOffset(-100, H) < -50, "it resists, the further the more");
  assert.ok(rubberBand(200, H) - rubberBand(100, H) < rubberBand(100, H) - rubberBand(0, H));
});

test("OA-31: the release speed comes from the last ~100 ms of samples only, keeping at least two", () => {
  const samples = new DragSamples();
  // A fast start (40 px per 16 ms) that slows to 2 px per 16 ms for the last 112 ms.
  let y = 0;
  for (let t = 16; t <= 96; t += 16) samples.push(t, (y += 40));
  for (let t = 112; t <= 224; t += 16) samples.push(t, (y += 2));
  assert.ok(samples.samples.every(([t]) => 224 - t <= 100), "nothing older than 100 ms is kept");
  assert.equal(samples.velocity(), 125, "2 px every 16 ms: the early flick is forgotten");
  const two = new DragSamples();
  two.push(0, 0);
  two.push(500, 50);
  assert.equal(two.samples.length, 2, "two samples are always kept, however far apart");
  assert.equal(two.velocity(), 100);
  // Trimmed at release instead of on each move (the Blast-mode panel's way, the gate's `bxSheetDown`): the same window.
  const all: [number, number][] = [];
  y = 0;
  for (let t = 16; t <= 96; t += 16) all.push([t, (y += 40)]);
  for (let t = 112; t <= 224; t += 16) all.push([t, (y += 2)]);
  assert.deepEqual(velocityWindow(all), samples.samples);
  assert.deepEqual(velocityWindow([[0, 0], [500, 50]]), [[0, 0], [500, 50]], "two are always kept");
  assert.equal(new DragSamples().velocity(), 0, "no samples, no speed");
  assert.equal(new DragSamples([10, 4]).velocity(), 0, "one sample, no speed");
});

test("OA-31: a finger that rested more than 60 ms before lifting has no speed left, however fast it moved", () => {
  const samples = new DragSamples();
  for (let t = 0; t <= 80; t += 16) samples.push(t, t * 3);
  const last = samples.samples.at(-1)![0];
  assert.equal(samples.velocity(last + 10), 3_000, "lifted at once: 3 px/ms");
  assert.equal(samples.velocity(last + 60), 3_000, "60 ms is still a flick");
  assert.equal(samples.velocity(last + 61), 0, "61 ms at rest: none");
  assert.equal(samples.velocity(), 3_000, "no release time (a cancelled gesture): the samples decide");
  for (const releasedAt of [undefined, last + 30, last + 90]) {
    assert.equal(releaseVelocity(samples.samples, releasedAt), gateRelease([...samples.samples] as [number, number][], 240, releasedAt).v);
  }
});

test("OA-31: the landing is projected the way scrolling decelerates: offset + (v/1000)·.998/(1−.998)", () => {
  for (const [offset, v] of [[0, 0], [100, 500], [40, 2_400], [300, -800], [-20, 0]] as const) {
    // The gate's `d.y + (v / 1000) * .998 / (1 - .998)`, with v read from samples one second apart.
    assert.equal(projectedRest(offset, v), gateRelease([[0, 0], [1_000, v]], offset, undefined).rest);
    assert.ok(Math.abs(projectedRest(offset, v) - (offset + v * 0.499)) < 1e-9);
  }
});

test("OA-31: past half the sheet's height it closes at the finger's speed (at least 600 px/s); short of it, it springs home", () => {
  // A slow pull past half: closes, at the minimum fling.
  assert.deepEqual(settleRelease(H * 0.6, 0, H), { kind: "close", offset: H * 0.6, velocity: 0, fling: 600 });
  // A flick from near the top: 1,500 px/s projects 748 px further, so it closes at 1,500 px/s.
  const flick = settleRelease(50, 1_500, H);
  assert.equal(flick.kind, "close");
  assert.equal(flick.kind === "close" && flick.fling, 1_500);
  // Exactly half does not close (the gate's `>`).
  assert.equal(settleRelease(H / 2, 0, H).kind, "home");
  // Pulled far down but heading back up: it still lands past half, and leaves at the minimum speed.
  const back = settleRelease(H * 0.9, -200, H);
  assert.equal(back.kind === "close" && back.fling, 600);
  // A short pull, released still: home, with the gate's spring.
  const home = settleRelease(120, 0, H);
  assert.equal(home.kind, "home");
  assert.deepEqual(home.kind === "home" && home.frames, gateSpringFrames(120, 0));
  assert.equal(home.kind === "home" && home.durationMs, ((gateSpringFrames(120, 0).length - 1) / 0.06));
  assert.deepEqual(springHome(-30, 0), { kind: "home", offset: -30, velocity: 0, frames: gateSpringFrames(-30, 0), durationMs: (gateSpringFrames(-30, 0).length - 1) / 0.06 });
});

test("OA-31: the spring is the gate's critically damped one, 60 fps keyframes, never past rest on the way down, settled at rest", () => {
  for (const from of [-80, -12, 0, 1, 60, 200, 480]) {
    for (const v0 of [-3_000, -900, -50, 0, 50, 900, 3_000]) {
      const frames = springFrames(from, v0);
      assert.deepEqual(frames, gateSpringFrames(from, v0), `${from} px at ${v0} px/s`);
      assert.equal(frames.at(-1), 0, "it ends at rest");
      assert.equal(frames[0], from >= 0 ? Math.max(0, from) : from, "it starts where the sheet is");
      if (from >= 0) assert.ok(frames.every((y) => y >= 0), `${from} at ${v0}: coming down it never lifts above rest`);
      assert.ok(Math.abs(frames.at(-2)!) < 0.5 || frames.length >= 121, "it stops within half a pixel of rest");
      assert.ok(frames.length <= 122, "and within two seconds");
      assert.equal(springDurationMs(frames), (frames.length - 1) / 0.06, "the gate's `(f.length - 1) / .06`");
    }
  }
  // Critically damped from rest: down it comes without a bounce (each frame no further from rest than the one before).
  const still = springFrames(240, 0);
  for (let index = 1; index < still.length; index += 1) assert.ok(still[index]! <= still[index - 1]!, `frame ${index}`);
  // The .34 s response: from 240 px, at rest within half a pixel after about 0.45 s (some 28 frames).
  assert.ok(still.length > 20 && still.length < 40, String(still.length));
});

test("OA-31: every exit leaves from where the sheet is: at the finger's speed after a fling (140–360 ms), 160 ms otherwise", () => {
  for (const [h, y0, v] of [[640, 300, 1_200], [640, 20, 600], [640, 600, 4_000], [844, 0, 9_000], [400, 380, 600]] as const) {
    const gate = gateExit(true, v, h, y0);
    assert.deepEqual(exitTiming(v, h, y0, true), { durationMs: gate.dur, easing: gate.ease });
  }
  assert.deepEqual(exitTiming(0, H, 120, true), { durationMs: 160, easing: "cubic-bezier(.23,1,.32,1)" });
  assert.deepEqual(exitTiming(1_000, H, 120, false), { durationMs: 160, easing: "cubic-bezier(.23,1,.32,1)" }, "wider screens never fling");
  assert.equal(exitTiming(600, 640, 20, true).durationMs, 360, "a slow pull is capped at 360 ms");
  assert.equal(exitTiming(9_000, 844, 0, true).durationMs, 281.3333333333333);
  assert.equal(exitTiming(90_000, 844, 0, true).durationMs, 140, "a hard flick is never under 140 ms");
});

test("OA-31: the scrim fades as the sheet goes down, never below .25, and not at all above rest", () => {
  assert.equal(scrimOpacity(0, H), 1);
  assert.equal(scrimOpacity(-40, H), 1);
  assert.equal(scrimOpacity(H / 4, H), 0.75);
  assert.equal(scrimOpacity(H * 0.9, H), 0.25);
  assert.equal(scrimOpacity(H * 2, H), 0.25);
});

/* ---------------- the gesture, press to release ---------------- */

function sheetAt(base = 0, closing = false): DragCatch & { caught: number } {
  const state = { caught: 0 };
  return Object.assign(state, {
    closing: () => closing,
    base: () => {
      state.caught += 1;
      return base;
    },
    height: () => H,
  });
}

const kinds = (steps: readonly DragStep[]) => steps.map((step) => (step.kind === "track" ? `${step.kind}${step.started ? "!" : ""}:${Number(step.offset.toFixed(2))}` : step.kind));

test("OA-31: 8 px of travel first, so a tap stays a tap; then 1:1 from where it was caught, without jumping by the slop", () => {
  const sheet = sheetAt();
  const gesture = new SheetDragGesture(100, 300, false);
  const steps = [gesture.move(100, 303, 16, sheet), gesture.move(101, 307, 32, sheet), gesture.move(101, 309, 48, sheet), gesture.move(102, 339, 64, sheet), gesture.move(102, 409, 80, sheet)];
  assert.deepEqual(kinds(steps), ["wait", "wait", "track!:0", "track:30", "track:100"]);
  assert.equal(sheet.caught, 1, "the live position is read once, when it is caught");
  assert.equal(gesture.tracking, true);
  assert.deepEqual(gesture.samples, [[48, 0], [64, 30], [80, 100]], "sampled from the catch on");
  // A tap: released before the slop, nothing to settle.
  const tap = new SheetDragGesture(0, 0, true);
  tap.move(0, 5, 16, sheet);
  assert.equal(tap.release(40, H), null);
});

test("OA-31: sideways first belongs to a sideways scroller; upward from the content scrolls it; the handle may pull up, rubber-banded", () => {
  const sheet = sheetAt();
  const sideways = new SheetDragGesture(0, 0, true);
  assert.deepEqual(kinds([sideways.move(12, 5, 16, sheet), sideways.move(12, 60, 32, sheet)]), ["cancel", "cancel"], "and it stays the scroller's");
  const content = new SheetDragGesture(0, 300, false);
  assert.deepEqual(kinds([content.move(0, 290, 16, sheet)]), ["cancel"]);
  const handle = new SheetDragGesture(0, 20, true);
  const [first, second] = [handle.move(0, 11, 16, sheet), handle.move(0, -89, 32, sheet)];
  assert.equal(first.kind, "track");
  assert.equal(second.kind === "track" && second.offset, -gateRub(100, H));
  // Diagonal but mostly down is the sheet's.
  const diagonal = new SheetDragGesture(0, 0, false);
  assert.equal(diagonal.move(9, 12, 16, sheet).kind, "track");
  assert.equal(sheet.caught, 2);
});

test("OA-31: a sheet is caught mid-open or mid-spring from its live position; a closing one cannot be caught", () => {
  const rising = sheetAt(260);
  const gesture = new SheetDragGesture(0, 600, false);
  const start = gesture.move(0, 610, 16, rising);
  assert.deepEqual(start, { kind: "track", offset: 260, started: true }, "held where it was drawn");
  assert.deepEqual(gesture.move(0, 650, 32, rising), { kind: "track", offset: 300, started: false });
  // Caught above rest: do not rubber-band the live position a second time.
  const above = new SheetDragGesture(0, 600, false);
  const caughtAbove = above.move(0, 610, 16, sheetAt(-20));
  assert.ok(caughtAbove.kind === "track" && Math.abs(caughtAbove.offset + 20) < 1e-9);
  const closing = sheetAt(100, true);
  const late = new SheetDragGesture(0, 600, false);
  assert.deepEqual(kinds([late.move(0, 640, 16, closing), late.move(0, 700, 32, closing)]), ["cancel", "cancel"]);
  assert.equal(closing.caught, 0);
  assert.equal(late.release(40, H), null);
});

test("OA-31: release: a flick past half closes at its speed, a slow short pull springs home, a rested lift has no speed", () => {
  const sheet = sheetAt();
  // A flick: 20 px every 16 ms (1,250 px/s), lifted at once at 140 px.
  const flick = new SheetDragGesture(0, 0, false);
  for (let t = 16, y = 10; t <= 128; t += 16, y += 20) flick.move(0, y, t, sheet);
  const flung = flick.release(130, H);
  assert.equal(flung?.kind, "close");
  assert.ok(flung?.kind === "close" && Math.abs(flung.fling - 1_250) < 1e-9, String(flung?.kind === "close" && flung.fling));
  assert.equal(flick.tracking, false);
  // The same pull, but the finger rested 100 ms before lifting: no speed, 140 px is short of half, so home.
  const rested = new SheetDragGesture(0, 0, false);
  for (let t = 16, y = 10; t <= 128; t += 16, y += 20) rested.move(0, y, t, sheet);
  const home = rested.release(228, H);
  assert.equal(home?.kind, "home");
  assert.equal(home?.velocity, 0);
  assert.deepEqual(home?.kind === "home" && home.frames, gateSpringFrames(rested.offset, 0));
  // A release after the gesture is over changes nothing.
  assert.equal(rested.release(300, H), null);
  assert.equal(rested.move(0, 900, 400, sheet).kind, "cancel");
});
