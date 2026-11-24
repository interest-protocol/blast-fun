import assert from "node:assert/strict";
import test from "node:test";

import type { FeelSignal } from "./feel-cues.ts";
import { FEEL_HOLD_ARM_MS, FEEL_HOLD_STEP_MS, FEEL_SWALLOW_CLICK_MS } from "./feel-hold.ts";
import { FeelHoldGesture, type HoldOutcome, type HoldRelease, type HoldTimers } from "./feel-hold-gesture.ts";
import { FeelScope, type FeelEventTarget, type FeelScopeHost } from "./feel-scope.ts";

/**
 * R3-13: hold to blast's gesture, every path, on a virtual clock. The
 * contract's timings (220 ms to arm, 650 ms a step), the ladder bounded by
 * the wallet's real balance, each cancel path writing nothing and leaving
 * nothing charged, the pointer filter, and the one swallowed click.
 */

function virtualClock() {
  let now = 0;
  let next = 1;
  const timers = new Map<number, { at: number; run: () => void }>();
  const host: FeelScopeHost = {
    setTimeout(handler, timeout) {
      const id = next++;
      timers.set(id, { at: now + timeout, run: handler });
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    setInterval() {
      throw new Error("the gesture uses no interval");
    },
    clearInterval() {},
    requestAnimationFrame() {
      throw new Error("the gesture uses no frame");
    },
    cancelAnimationFrame() {},
  };
  return {
    host,
    get now() {
      return now;
    },
    /** Moves time forward, running every timer that falls due, in order. */
    advance(ms: number) {
      const until = now + ms;
      for (;;) {
        const due = [...timers.entries()].filter(([, timer]) => timer.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        now = due[1].at;
        due[1].run();
      }
      now = until;
    },
    pending: () => timers.size,
  };
}

function eventTarget() {
  const listeners: { type: string; callback: EventListener }[] = [];
  const target: FeelEventTarget = {
    addEventListener(type, callback) {
      listeners.push({ type, callback: callback as EventListener });
    },
    removeEventListener(type, callback) {
      const at = listeners.findIndex((entry) => entry.type === type && entry.callback === callback);
      if (at >= 0) listeners.splice(at, 1);
    },
  };
  return {
    target,
    emit(type: string, event: Record<string, unknown> = {}) {
      for (const entry of [...listeners]) if (entry.type === type) entry.callback(event as unknown as Event);
    },
    count: () => listeners.length,
  };
}

const BUTTON = { id: "blast-button" };
const ICON = { id: "icon-inside-the-button" };
const ELSEWHERE = { id: "another-control" };

function rig(options: Readonly<{ usdc?: number | null }> = {}) {
  const clock = virtualClock();
  const scope = new FeelScope(clock.host);
  const window = eventTarget();
  const document = eventTarget();
  let usdc: number | null = options.usdc === undefined ? 10_000 : options.usdc;
  const charges: (number | null)[] = [];
  const releases: HoldRelease[] = [];
  const outcomes: HoldOutcome[] = [];
  const played: FeelSignal[] = [];
  const gesture = new FeelHoldGesture({
    scope,
    events: window.target,
    clicks: document.target,
    play: (signal) => played.push(signal),
    availableUsd: () => usdc,
    onCharge: (level) => charges.push(level),
    onRelease: (release) => releases.push(release),
    onEnd: (outcome) => outcomes.push(outcome),
  });
  const press = (pointerId = 1, x = 100, y = 100) =>
    gesture.press({ pointerId, x, y, contains: (node) => node === BUTTON || node === ICON });
  return {
    clock,
    scope,
    window,
    document,
    gesture,
    press,
    charges,
    releases,
    outcomes,
    played,
    setUsdc(value: number | null) {
      usdc = value;
    },
    /** What the button shows now: the last charge level reported, or null. */
    shown: () => (charges.length === 0 ? null : charges[charges.length - 1]!),
  };
}

test("R3-13-AC-1: held 1.0 s it charges to $100; held 2.3 s to $1,000; released at 150 ms it charges nothing", () => {
  const one = rig();
  one.press();
  one.clock.advance(1_000);
  assert.equal(one.gesture.level, 1);
  one.window.emit("pointerup", { pointerId: 1 });
  assert.deepEqual(one.releases, [{ level: 1, amountUsd: 100 }]);
  assert.deepEqual(one.played.map((signal) => (signal.kind === "tick" ? `tick${signal.level}` : signal.kind)), ["tick0", "tick1"]);

  const long = rig();
  long.press();
  long.clock.advance(2_300);
  long.window.emit("pointerup", { pointerId: 1 });
  assert.deepEqual(long.releases, [{ level: 3, amountUsd: 1_000 }]);
  assert.deepEqual(long.charges, [0, 1, 2, 3, null], "every rung shown, then the glow and label let go");

  const tap = rig();
  tap.press();
  tap.clock.advance(150);
  tap.window.emit("pointerup", { pointerId: 1 });
  assert.deepEqual(tap.releases, [], "nothing charged");
  assert.deepEqual(tap.charges, [], "the button never changed");
  assert.deepEqual(tap.outcomes, ["tap"]);
  // The ordinary click is not swallowed.
  const click = { pointerId: 1, target: BUTTON, stopped: false, stopPropagation() { this.stopped = true; }, preventDefault() {} };
  tap.document.emit("click", click);
  assert.equal(click.stopped, false);
});

test("R3-13: the rungs land on the gate's clock — 220 ms to arm, then 650 ms a step", () => {
  const { clock, press, gesture } = rig();
  press();
  clock.advance(FEEL_HOLD_ARM_MS - 1);
  assert.equal(gesture.phase, "pressed");
  clock.advance(1);
  assert.equal(gesture.level, 0);
  clock.advance(FEEL_HOLD_STEP_MS - 1);
  assert.equal(gesture.level, 0);
  clock.advance(1);
  assert.equal(gesture.level, 1);
  clock.advance(FEEL_HOLD_STEP_MS * 2);
  assert.equal(gesture.level, 3);
  clock.advance(FEEL_HOLD_STEP_MS * 5);
  assert.equal(gesture.level, 3, "the ladder ends at $1,000");
});

test("R3-13-AC-2: with $120 of USDC the ladder stops at $100, and the release commits $100", () => {
  const { clock, press, gesture, window, releases, played } = rig({ usdc: 120 });
  press();
  clock.advance(5_000);
  assert.equal(gesture.level, 1);
  window.emit("pointerup", { pointerId: 1 });
  assert.deepEqual(releases, [{ level: 1, amountUsd: 100 }]);
  assert.equal(played.filter((signal) => signal.kind === "tick").length, 2, "no tick for a rung it cannot pay");
});

test("R3-13: the ladder reads the balance at every step, and waits on the first rung until the wallet has answered", () => {
  const { clock, press, gesture, setUsdc } = rig({ usdc: null });
  press();
  clock.advance(FEEL_HOLD_ARM_MS + FEEL_HOLD_STEP_MS * 3);
  assert.equal(gesture.level, 0, "no climbing on a guess");
  setUsdc(600);
  clock.advance(FEEL_HOLD_STEP_MS);
  assert.equal(gesture.level, 1);
  clock.advance(FEEL_HOLD_STEP_MS * 3);
  assert.equal(gesture.level, 2, "$500 covered, $1,000 not");
  // The balance moves under the hold: the ladder does not go back, and does not climb past it.
  setUsdc(50);
  clock.advance(FEEL_HOLD_STEP_MS * 3);
  assert.equal(gesture.level, 2);
});

test("R3-13: a wallet known not to cover $50 never charges; the press stays the button's own press", () => {
  const { clock, press, window, charges, releases, outcomes } = rig({ usdc: 20 });
  press();
  clock.advance(2_000);
  window.emit("pointerup", { pointerId: 1 });
  assert.deepEqual(charges, []);
  assert.deepEqual(releases, []);
  assert.deepEqual(outcomes, ["unaffordable"]);
});

test("R3-13-AC-3: each cancel path — a 41 px drag, Escape, pointercancel, lostpointercapture, another element taking the pointer, the window's blur — reverts and sends nothing", () => {
  const paths: readonly [string, (r: ReturnType<typeof rig>) => void][] = [
    ["drag", (r) => r.window.emit("pointermove", { pointerId: 1, clientX: 141, clientY: 100 })],
    ["escape", (r) => r.window.emit("keydown", { key: "Escape" })],
    ["pointercancel", (r) => r.window.emit("pointercancel", { pointerId: 1 })],
    ["lostpointercapture", (r) => r.window.emit("lostpointercapture", { pointerId: 1 })],
    // A swipe around the button took a mouse's pointer (a mouse holds no capture to lose).
    ["captured", (r) => r.window.emit("gotpointercapture", { pointerId: 1, target: ELSEWHERE })],
    ["blur", (r) => r.window.emit("blur", { target: r.window.target })],
  ];
  for (const [reason, cancel] of paths) {
    const r = rig();
    r.press();
    r.clock.advance(1_000);
    assert.equal(r.gesture.level, 1, reason);
    cancel(r);
    assert.equal(r.gesture.phase, "idle", reason);
    assert.equal(r.shown(), null, `${reason}: label and glow reverted`);
    assert.deepEqual(r.outcomes, [reason]);
    // Nothing comes after: no release, no rung, no listener, no timer.
    r.window.emit("pointerup", { pointerId: 1 });
    r.clock.advance(5_000);
    assert.deepEqual(r.releases, [], `${reason}: no commit`);
    assert.equal(r.window.count(), 0, `${reason}: every listener off`);
    assert.equal(r.clock.pending(), 0, `${reason}: every timer off`);
    // The click that follows a cancelled hold is the button's own: not swallowed.
    const click = { pointerId: 1, target: BUTTON, stopped: false, stopPropagation() { this.stopped = true; }, preventDefault() {} };
    r.document.emit("click", click);
    assert.equal(click.stopped, false, reason);
  }
});

test("R3-13: a drag of exactly 40 px keeps the charge; an element's blur inside the page does not cancel it", () => {
  const r = rig();
  r.press();
  r.clock.advance(1_000);
  r.window.emit("pointermove", { pointerId: 1, clientX: 124, clientY: 132 });
  assert.equal(r.gesture.level, 1);
  r.window.emit("blur", { target: ELSEWHERE });
  assert.equal(r.gesture.phase, "charging");
});

test("R3-13: the button's own pointer capture (a touch's implicit one, on the button or inside it) keeps the charge", () => {
  const r = rig();
  r.press();
  r.window.emit("gotpointercapture", { pointerId: 1, target: ICON });
  r.clock.advance(1_000);
  r.window.emit("gotpointercapture", { pointerId: 1, target: BUTTON });
  assert.equal(r.gesture.phase, "charging");
  r.window.emit("pointerup", { pointerId: 1 });
  assert.deepEqual(r.releases, [{ level: 1, amountUsd: 100 }]);
});

test("R3-13: only the pressing pointer moves, releases or cancels the hold", () => {
  const r = rig();
  r.press(7);
  r.clock.advance(1_000);
  r.window.emit("pointermove", { pointerId: 9, clientX: 500, clientY: 500 });
  r.window.emit("pointercancel", { pointerId: 9 });
  r.window.emit("lostpointercapture", { pointerId: 9 });
  r.window.emit("gotpointercapture", { pointerId: 9, target: ELSEWHERE });
  r.window.emit("pointerup", { pointerId: 9 });
  assert.equal(r.gesture.phase, "charging", "a second finger does nothing to it");
  r.window.emit("pointerup", { pointerId: 7 });
  assert.deepEqual(r.releases, [{ level: 1, amountUsd: 100 }]);
});

test("R3-13: a charged release swallows exactly its own click — inside the button, same pointer — and nothing else", () => {
  const r = rig();
  r.press(3);
  r.clock.advance(1_000);
  r.window.emit("pointerup", { pointerId: 3 });
  const click = (target: unknown, pointerId: number) => {
    const event = { target, pointerId, stopped: false, prevented: false, stopPropagation() { this.stopped = true; }, preventDefault() { this.prevented = true; } };
    r.document.emit("click", event);
    return event;
  };
  // Another control, or another pointer on the button, goes through.
  assert.equal(click(ELSEWHERE, 3).stopped, false);
  assert.equal(click(BUTTON, 4).stopped, false);
  // The release's own click on the button's icon is swallowed, once.
  const own = click(ICON, 3);
  assert.equal(own.stopped && own.prevented, true);
  assert.equal(click(BUTTON, 3).stopped, false, "only one");
  assert.equal(r.document.count(), 0);
});

test("R3-13: the swallow gives up after its window, so a click that never comes cannot eat a later one", () => {
  const r = rig();
  r.press();
  r.clock.advance(1_000);
  r.window.emit("pointerup", { pointerId: 1 });
  assert.equal(r.document.count(), 1);
  r.clock.advance(FEEL_SWALLOW_CLICK_MS);
  assert.equal(r.document.count(), 0);
});

test("R3-13: a new press calls the held one off; dispose mid-charge leaves nothing charged and nothing running", () => {
  const r = rig();
  r.press(1);
  r.clock.advance(1_000);
  r.press(2);
  assert.deepEqual(r.outcomes, ["replaced"]);
  assert.equal(r.shown(), null);
  r.clock.advance(1_000);
  assert.equal(r.gesture.level, 1, "the new press charges on its own clock");
  r.gesture.dispose();
  assert.equal(r.shown(), null);
  assert.equal(r.gesture.phase, "idle");
  assert.equal(r.clock.pending(), 0);
  assert.equal(r.window.count(), 0);
  r.gesture.dispose();
  assert.deepEqual(r.outcomes, ["replaced", "disposed"], "disposing twice is safe");
  r.scope.stop();
});

/** An owner's task registry: it counts what it holds, and closing it stops every timer and listener. */
function taskRegistry(clock: ReturnType<typeof virtualClock>) {
  const timers = new Set<number>();
  const listeners = new Set<() => void>();
  const tasks: HoldTimers = {
    after: (run, ms) => {
      const id = clock.host.setTimeout(() => {
        timers.delete(id);
        run();
      }, ms) as number;
      timers.add(id);
      return id;
    },
    clear: (handle) => {
      if (handle === null || handle === undefined) return;
      timers.delete(handle);
      clock.host.clearTimeout(handle);
    },
    on: (target, type, listener, options) => {
      target.addEventListener(type, listener, options);
      const off = () => {
        listeners.delete(off);
        target.removeEventListener(type, listener, options);
      };
      listeners.add(off);
      return off;
    },
  };
  return {
    tasks,
    counts: () => ({ timers: timers.size, listeners: listeners.size }),
    close() {
      for (const id of timers) clock.host.clearTimeout(id);
      timers.clear();
      for (const off of [...listeners]) off();
    },
  };
}

test("R3-13: on an owner's task registry the hold's timers and listeners are the owner's, and closing it stops them", async () => {
  const clock = virtualClock();
  const store = taskRegistry(clock);
  const { holdScopeOnTasks } = await import("./feel-hold-gesture.ts");
  const added: { type: string; capture: boolean }[] = [];
  const events = {
    addEventListener: (type: string, _listener: unknown, options?: AddEventListenerOptions) => added.push({ type, capture: options?.capture === true }),
    removeEventListener: () => undefined,
  } as unknown as EventTarget;
  const charges: (number | null)[] = [];
  const gesture = new FeelHoldGesture({
    scope: holdScopeOnTasks(store.tasks),
    events,
    clicks: events,
    play: () => undefined,
    availableUsd: () => 10_000,
    onCharge: (level) => charges.push(level),
    onRelease: () => undefined,
  });
  gesture.press({ pointerId: 1, x: 0, y: 0, contains: () => true });
  const counts = store.counts();
  assert.equal(counts.timers, 1, "the arm timer is the owner's");
  assert.equal(counts.listeners, 7, "move, up, cancel, lost capture, capture taken, Escape and blur are the owner's");
  assert.ok(added.every((entry) => entry.capture), "in the capture phase, as the layer's own scope listens");
  clock.advance(1_000);
  assert.deepEqual(charges, [0, 1]);
  // The owner closes: nothing it scheduled for the hold is left, and no rung follows.
  store.close();
  assert.equal(clock.pending(), 0);
  clock.advance(5_000);
  assert.deepEqual(charges, [0, 1]);
  gesture.dispose();
  assert.deepEqual(charges, [0, 1, null], "and the button lets go when the card goes");
});
