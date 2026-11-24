import assert from "node:assert/strict";
import test, { afterEach, mock } from "node:test";
import { installTestDom } from "../../../../test/fixtures/social/test-dom.ts";
const dom = installTestDom();
afterEach(() => mock.restoreAll());

import { anyFreshness, minimumGap, pollingFreshness, type FreshnessEnvironment } from "./feed-freshness.ts";

/** UI-02 / T-012: when the home feed asks for new posts, without a browser. */

function fakeEnvironment(visible = true) {
  const intervals = new Map<number, { run: () => void; ms: number }>();
  const listeners = new Set<() => void>();
  let next = 0;
  let isVisible = visible;
  const environment: FreshnessEnvironment = {
    visible: () => isVisible,
    onVisibilityChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    setInterval(run, ms) {
      next += 1;
      intervals.set(next, { run, ms });
      return next;
    },
    clearInterval(handle) {
      intervals.delete(handle as number);
    },
  };
  mock.getter(dom.document, "visibilityState", () => isVisible ? "visible" : "hidden");
  mock.method(dom.document, "addEventListener", ((name: string, listener: () => void) => { if (name === "visibilitychange") listeners.add(listener); }) as typeof document.addEventListener);
  mock.method(dom.document, "removeEventListener", ((name: string, listener: () => void) => { if (name === "visibilitychange") listeners.delete(listener); }) as typeof document.removeEventListener);
  mock.method(dom.window, "setInterval", environment.setInterval as typeof window.setInterval);
  mock.method(dom.window, "clearInterval", environment.clearInterval);
  return {
    environment,
    intervals,
    tick: () => [...intervals.values()].forEach((interval) => interval.run()),
    setVisible(value: boolean) {
      isVisible = value;
      for (const listener of listeners) listener();
    },
    listeners,
  };
}

test("T-012-AC-1 (AC-068): the poll signals every 30 s only while visible, and at once on becoming visible", () => {
  const fake = fakeEnvironment(true);
  let signals = 0;
  const off = pollingFreshness(30_000).subscribe(() => {
    signals += 1;
  });
  const periods = [...fake.intervals.values()].map((interval) => interval.ms);
  assert.equal(periods.length, 1);
  assert.ok(periods[0]! >= 30_000 && periods[0]! <= 36_000, "each tab polls on its own 30–36 s period");
  fake.tick();
  assert.equal(signals, 1);
  // A hidden tab makes no requests: the interval stops.
  fake.setVisible(false);
  assert.equal(fake.intervals.size, 0);
  fake.tick();
  assert.equal(signals, 1);
  // Back: one look at once, then the interval again.
  fake.setVisible(true);
  assert.equal(signals, 2);
  assert.equal(fake.intervals.size, 1);
  off();
  assert.equal(fake.intervals.size, 0);
  assert.equal(fake.listeners.size, 0);
});

test("T-012: a tab hidden at the start polls only once it is shown", () => {
  const fake = fakeEnvironment(false);
  let signals = 0;
  pollingFreshness(30_000).subscribe(() => {
    signals += 1;
  });
  assert.equal(fake.intervals.size, 0);
  fake.setVisible(true);
  assert.equal(signals, 1);
});

test("T-012-AC-1: three signals within 2 s read once, one 6 s later reads again; a caught-up reader resets the gap", () => {
  const gate = minimumGap(5_000);
  assert.deepEqual([gate.allow(1_000), gate.allow(1_800), gate.allow(2_900)], [true, false, false]);
  assert.equal(gate.allow(7_000), true);
  assert.equal(gate.allow(7_100), false);
  gate.reset();
  assert.equal(gate.allow(7_200), true);
});

test("T-012: sources combine (the activity hint later, the poll as its fallback)", () => {
  const signals: string[] = [];
  let emitHint: () => void = () => undefined;
  const hint = { name: "hint", subscribe: (signal: () => void) => { emitHint = signal; return () => { emitHint = () => undefined; }; } };
  const fake = fakeEnvironment(true);
  const off = anyFreshness(hint, pollingFreshness(30_000)).subscribe(() => signals.push("look"));
  emitHint();
  fake.tick();
  assert.deepEqual(signals, ["look", "look"]);
  off();
  emitHint();
  assert.equal(signals.length, 2);
  assert.equal(fake.intervals.size, 0);
});
