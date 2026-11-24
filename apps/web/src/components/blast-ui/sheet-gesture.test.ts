import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";

import { installTestDom, recordAnimations, testEvent, type TestAnimation, type TestElement } from "../../../test/fixtures/social/test-dom.ts";

/**
 * OA-31 / OA-28 M2: the shared pull-down on a page — where a press may start,
 * what a move draws, and how a release ends — with the touch and pointer
 * events a phone and a mouse send (the test DOM's, 16 ms apart). The numbers
 * themselves are `sheet-gesture-model.test.ts`'s; the browser check repeats
 * the gestures against the gate with real touches.
 */

const { document, window } = installTestDom();
const motion = recordAnimations();
Object.defineProperty(window, "innerHeight", { value: 844, configurable: true, writable: true });

const { bindSheetGesture } = await import("./sheet-gesture");
const { rubberBand, springFrames, scrimOpacity } = await import("./sheet-gesture-model");

const TOP = 300;
const HEIGHT = 544;

type Fixture = Readonly<{
  scrim: TestElement;
  sheet: TestElement;
  body: TestElement;
  handle: TestElement;
  closes: number[];
  styles: Map<TestElement, { transform?: string; overflowY?: string; opacity?: string }>;
  state: { enabled: boolean; closing: boolean };
  unbind: () => void;
}>;

/** A phone's bottom sheet, 544 px tall with its top at 300 px, holding a scrollable body with a field and a button. */
function fixture(t: TestContext): Fixture {
  const scrim = document.createElement("div");
  const sheet = document.createElement("div");
  const handle = document.createElement("h2");
  const body = document.createElement("div");
  scrim.appendChild(sheet);
  sheet.appendChild(handle);
  sheet.appendChild(body);
  for (const tag of ["input", "textarea", "select", "button"]) body.appendChild(document.createElement(tag));
  const editable = document.createElement("div");
  editable.setAttribute("contenteditable", "");
  const own = document.createElement("div");
  own.className = "no-drag";
  body.appendChild(editable);
  body.appendChild(own);
  document.body.appendChild(scrim);
  Object.defineProperty(sheet, "offsetHeight", { value: HEIGHT });
  sheet.getBoundingClientRect = () => ({ x: 0, y: TOP, top: TOP, left: 0, right: 390, bottom: TOP + HEIGHT, width: 390, height: HEIGHT, toJSON: () => ({}) });
  const styles = new Map<TestElement, { transform?: string; overflowY?: string; opacity?: string }>([[sheet, { overflowY: "auto" }]]);
  const closes: number[] = [];
  const state = { enabled: true, closing: false };
  const unbind = bindSheetGesture({
    sheet: sheet as unknown as HTMLElement,
    scrim: scrim as unknown as HTMLElement,
    enabled: () => state.enabled,
    closing: () => state.closing,
    close: (fling) => void closes.push(fling),
    read: (element) => styles.get(element as unknown as TestElement) ?? {},
  });
  t.after(() => {
    unbind();
    scrim.parentNode?.removeChild(scrim);
    motion.all.length = 0;
  });
  return { scrim, sheet, body, handle, closes, styles, state, unbind };
}

let clock = 1_000;

function touch(target: TestElement, type: "touchstart" | "touchmove" | "touchend" | "touchcancel", y: number, x = 200, fingers = 1) {
  const touches = type === "touchend" || type === "touchcancel" ? [] : Array.from({ length: fingers }, () => ({ clientX: x, clientY: y }));
  const event = testEvent(type, { timeStamp: clock, cancelable: true } as never) as ReturnType<typeof testEvent> & { touches: unknown };
  event.touches = touches;
  target.dispatchEvent(event);
  return event;
}

function pointer(target: TestElement, type: string, y: number, init: Readonly<{ pointerType?: string; button?: number; x?: number }> = {}) {
  const event = testEvent(type, { timeStamp: clock, pointerType: init.pointerType ?? "mouse", button: init.button ?? 0, clientX: init.x ?? 200, clientY: y, pointerId: 7 } as never) as ReturnType<typeof testEvent> & Record<string, unknown>;
  target.dispatchEvent(event);
  return event;
}

/** A finger down at `from`, moving to each y 16 ms apart; answers the moves' events. */
function drag(target: TestElement, from: number, ys: readonly number[], x = 200) {
  touch(target, "touchstart", from, x);
  return ys.map((y) => {
    clock += 16;
    return touch(target, "touchmove", y, x);
  });
}

const translate = (sheet: TestElement) => String(sheet.style.transform ?? "");
const offsetOf = (sheet: TestElement) => Number(/translateY\((-?[\d.e-]+)px\)/.exec(translate(sheet))?.[1] ?? 0);
const running = (element: TestElement) => motion.all.filter((animation) => animation.target === element && animation.playState === "running");

test("OA-31: by the handle, a pull waits 8 px, then tracks 1:1 from there, fading the scrim; the content's own scroll is stopped only while it is held", (t) => {
  const { sheet, scrim, handle } = fixture(t);
  const moves = drag(handle, TOP + 10, [TOP + 15, TOP + 19, TOP + 59, TOP + 209]);
  assert.deepEqual(moves.map((event) => event.defaultPrevented), [false, true, true, true], "the first 5 px are a tap's");
  assert.equal(sheet.getAttribute("data-dragging"), "", "held: no text selection");
  assert.equal(offsetOf(sheet), 190, "tracked from the move that caught it, so it never jumped by the slop");
  assert.equal(Number(scrim.style.opacity), scrimOpacity(190, HEIGHT));
});

test("OA-31: from anywhere once the content is at the top; never once it is scrolled, and never from a field or a .no-drag part", (t) => {
  const { sheet, body, styles } = fixture(t);
  drag(body, TOP + 200, [TOP + 230, TOP + 330]);
  assert.equal(offsetOf(sheet), 100, "the content at its top: the sheet comes down");
  touch(body, "touchend", TOP + 330);
  clock += 1_000;
  motion.finishAll();
  sheet.style.transform = "";

  sheet.scrollTop = 120;
  drag(body, TOP + 200, [TOP + 230, TOP + 330]);
  assert.equal(translate(sheet), "", "scrolled down: the finger scrolls the content back up instead");
  sheet.scrollTop = 0;
  styles.set(body, { overflowY: "scroll" });
  body.scrollTop = 40;
  drag(body.querySelector("button")!, TOP + 200, [TOP + 230, TOP + 330]);
  assert.equal(translate(sheet), "", "an inner scroller away from its top keeps the gesture too");
  body.scrollTop = 0;

  for (const selector of ["input", "textarea", "select", "[contenteditable]", ".no-drag"]) {
    const moves = drag(body.querySelector<HTMLElement>(selector)!, TOP + 200, [TOP + 230, TOP + 330]);
    assert.equal(translate(sheet), "", selector);
    assert.ok(moves.every((event) => !event.defaultPrevented), `${selector} keeps its own gesture`);
  }
});

test("OA-31: sideways first is a sideways scroller's; upward from the content scrolls it; upward by the handle rubber-bands", (t) => {
  const { sheet, body, handle } = fixture(t);
  drag(body, TOP + 200, [TOP + 203], 200);
  drag(body, TOP + 200, [TOP + 202, TOP + 240], 212);
  assert.equal(translate(sheet), "", "12 px sideways before 8 px down: never the sheet's");
  const up = drag(body, TOP + 200, [TOP + 190, TOP + 100]);
  assert.equal(translate(sheet), "", "scrolling the content up");
  assert.ok(up.every((event) => !event.defaultPrevented));
  drag(handle, TOP + 20, [TOP + 10, TOP - 90]);
  assert.equal(offsetOf(sheet), -rubberBand(100, HEIGHT), "100 px up by the handle: the gate's band");
});

test("OA-31: released past half its height it closes at the finger's speed; the sheet stays where the finger left it for the exit to start from", (t) => {
  const { sheet, handle, closes } = fixture(t);
  // 25 px every 16 ms (1,562.5 px/s) for 128 ms, lifted at once at 200 px: 200 + 780 > 272.
  drag(handle, TOP + 10, [TOP + 20, ...Array.from({ length: 8 }, (_, index) => TOP + 20 + 25 * (index + 1))]);
  clock += 4;
  touch(handle, "touchend", 0);
  assert.equal(closes.length, 1);
  assert.equal(closes[0], 1_562.5);
  assert.equal(offsetOf(sheet), 200);
  assert.equal(sheet.getAttribute("data-dragging"), null);
  assert.equal(running(sheet).length, 0, "no spring: the close takes it from here");
});

test("OA-31: released short of half it springs home on the compositor: the gate's keyframes, linear, 60 fps, scrim following", (t) => {
  const { sheet, scrim, handle, closes } = fixture(t);
  // 2 px every 16 ms (125 px/s) to 80 px: it would land at 80 + 62 px, short of 272.
  drag(handle, TOP + 10, Array.from({ length: 41 }, (_, index) => TOP + 20 + 2 * index));
  clock += 10;
  touch(handle, "touchend", 0);
  assert.equal(closes.length, 0);
  assert.equal(translate(sheet), "", "rest is the inline state; the spring plays over it");
  assert.equal(scrim.style.opacity, "1");
  const [spring] = running(sheet) as TestAnimation[];
  const frames = springFrames(80, 125);
  assert.deepEqual(
    spring!.keyframes.map((frame) => frame.transform),
    frames.map((y) => `translateY(${y}px)`),
  );
  assert.ok(frames.every((y) => y >= 0), "coming down to rest it never lifts above it");
  const [fade] = running(scrim) as TestAnimation[];
  assert.deepEqual(
    fade!.keyframes.map((frame) => frame.opacity),
    frames.map((y) => scrimOpacity(y, HEIGHT)),
  );
});

test("OA-31: a finger that rests before lifting has no speed: a long slow pull past half still closes, at the minimum 600 px/s", (t) => {
  const { sheet, handle, closes } = fixture(t);
  drag(handle, TOP + 10, [TOP + 20, TOP + 120, TOP + 220, TOP + 320]);
  clock += 200;
  touch(handle, "touchend", 0);
  assert.deepEqual(closes, [600]);
  // The same pull to 120 px, rested: home, from rest speed 0.
  sheet.style.transform = "";
  drag(handle, TOP + 10, [TOP + 20, TOP + 140]);
  clock += 100;
  touch(handle, "touchend", 0);
  assert.deepEqual(closes, [600]);
  const spring = running(sheet).at(-1)!;
  assert.deepEqual(
    spring.keyframes.map((frame) => frame.transform),
    springFrames(120, 0).map((y) => `translateY(${y}px)`),
  );
});

test("OA-31: caught mid-open or mid-spring it starts from where it is drawn, the motion finished (not cancelled); a closing sheet cannot be caught", (t) => {
  const { sheet, scrim, handle, styles, state } = fixture(t);
  const rise = sheet.animate([{ transform: "translateY(100%)" }, { transform: "none" }], {}) as unknown as TestAnimation;
  const fade = scrim.animate([{ opacity: 0 }, { opacity: 1 }], {}) as unknown as TestAnimation;
  let finishedWith = "";
  rise.onfinish = () => {
    finishedWith = "finish";
  };
  styles.set(sheet, { overflowY: "auto", transform: "matrix(1, 0, 0, 1, 0, 230)" });
  drag(handle, TOP + 240, [TOP + 252]);
  assert.equal(rise.playState, "finished");
  assert.equal(fade.playState, "finished");
  assert.equal(finishedWith, "finish", "a step swap caught mid-way still lands");
  assert.equal(offsetOf(sheet), 230, "held where it was drawn");
  clock += 16;
  touch(handle, "touchmove", TOP + 282);
  assert.equal(offsetOf(sheet), 260);
  touch(handle, "touchcancel", 0);

  sheet.style.transform = "";
  styles.set(sheet, { overflowY: "auto" });
  state.closing = true;
  drag(handle, TOP + 10, [TOP + 30, TOP + 90]);
  assert.equal(translate(sheet), "", "on its way out: it keeps going");
});

test("OA-31: a mouse or a pen pulls by the handle only, never from a control, and takes the capture; touches leave pointer events alone", (t) => {
  const { sheet, body, handle } = fixture(t);
  const captured: number[] = [];
  (sheet as unknown as { setPointerCapture: (id: number) => void }).setPointerCapture = (id) => void captured.push(id);
  pointer(body, "pointerdown", TOP + 200);
  clock += 16;
  pointer(sheet, "pointermove", TOP + 260);
  assert.equal(translate(sheet), "", "a mouse on the content selects text, it does not pull");
  pointer(sheet, "pointerup", TOP + 260);

  const close = document.createElement("button");
  handle.appendChild(close);
  pointer(close, "pointerdown", TOP + 12);
  clock += 16;
  pointer(sheet, "pointermove", TOP + 80);
  assert.equal(translate(sheet), "", "the close button is a button");
  pointer(sheet, "pointerup", TOP + 80);

  pointer(handle, "pointerdown", TOP + 12, { button: 2 });
  pointer(handle, "pointerdown", TOP + 12, { pointerType: "touch" });
  clock += 16;
  pointer(sheet, "pointermove", TOP + 80, { pointerType: "touch" });
  assert.equal(translate(sheet), "", "a right button, or a finger's pointer events, never pull");

  pointer(handle, "pointerdown", TOP + 12, { pointerType: "pen" });
  assert.deepEqual(captured, [7]);
  for (const y of [TOP + 22, TOP + 72]) {
    clock += 16;
    pointer(sheet, "pointermove", y, { pointerType: "pen" });
  }
  assert.equal(offsetOf(sheet), 50);
  clock += 100;
  pointer(sheet, "pointerup", TOP + 72, { pointerType: "pen" });
  assert.equal(translate(sheet), "", "held still, then lifted: it springs home");
  assert.deepEqual(
    running(sheet).at(-1)!.keyframes.map((frame) => frame.transform),
    springFrames(50, 0).map((y) => `translateY(${y}px)`),
  );
});

test("OA-31: phones only, one finger only; unbinding mid-pull hands the sheet back", (t) => {
  const { sheet, handle, state, unbind, scrim } = fixture(t);
  state.enabled = false;
  drag(handle, TOP + 10, [TOP + 30, TOP + 90]);
  assert.equal(translate(sheet), "", "wider than a phone: no pull");
  state.enabled = true;
  touch(handle, "touchstart", TOP + 10, 200, 2);
  clock += 16;
  touch(handle, "touchmove", TOP + 90);
  assert.equal(translate(sheet), "", "two fingers are a pinch");
  drag(handle, TOP + 10, [TOP + 30, TOP + 90]);
  assert.equal(offsetOf(sheet), 60);
  unbind();
  assert.equal(translate(sheet), "");
  assert.equal(scrim.style.opacity, "1");
  assert.equal(sheet.getAttribute("data-dragging"), null);
  clock += 16;
  touch(handle, "touchmove", TOP + 200);
  assert.equal(translate(sheet), "", "and stops listening");
});

test("cancelled touch and pointer drags return home instead of dismissing, even beyond the close threshold", (t) => {
  const { sheet, handle, closes } = fixture(t);
  drag(handle, TOP + 10, [TOP + 20, TOP + 420]);
  touch(handle, "touchcancel", 0);
  assert.equal(closes.length, 0);
  assert.equal(translate(sheet), "");
  assert.equal(running(sheet).at(-1)?.keyframes[0]?.transform, "translateY(400px)");
  motion.finishAll();
  pointer(handle, "pointerdown", TOP + 10);
  clock += 16;
  pointer(sheet, "pointermove", TOP + 20);
  clock += 16;
  pointer(sheet, "pointermove", TOP + 420);
  pointer(sheet, "pointercancel", 0);
  assert.equal(closes.length, 0);
  assert.equal(translate(sheet), "");
});
