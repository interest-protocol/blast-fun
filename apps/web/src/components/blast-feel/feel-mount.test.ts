import assert from "node:assert/strict";
import test from "node:test";

import type { FeelNode, FeelSignal } from "./feel-cues.ts";
import { isFeelNode, mountFeelCues } from "./feel-mount.ts";
import { feelActive, FeelScope, type FeelEventTarget, type FeelScopeHost } from "./feel-scope.ts";

/**
 * OA-23 / FEEL-LAYER.md §5: the leak check.
 *
 * The gate's base build keeps every timer in `BX.timers`, every frame in
 * `BX.rafs` and every listener on one `AbortController`, clears them in one
 * `bxStop()`, and reports `window.bxActive()`. Its own leak check is "20 enters
 * and exits leave 0 timers, 0 frames and the same listener count".
 *
 * The Feel lab is the one part of the gate outside that discipline: bare
 * `setTimeout`, nine permanent capture listeners, a ball appended to
 * `document.body`, nothing registered anywhere. This is that discipline put
 * back, and this file is the gate's own leak check run against it — the same 20
 * cycles, over the real mount path, with a pending timer, a pending frame, a
 * live listener and a ball still on the page in every one of them.
 */

type Harness = Readonly<{
  host: FeelScopeHost;
  pending: () => Readonly<{ timeouts: number; intervals: number; frames: number }>;
  fire: (id: number) => void;
}>;

function fakeHost(): Harness {
  let next = 1;
  const timeouts = new Map<number, () => void>();
  const intervals = new Map<number, () => void>();
  const frames = new Map<number, (time: number) => void>();
  return {
    host: {
      setTimeout(handler) {
        const id = next++;
        timeouts.set(id, handler);
        return id;
      },
      clearTimeout(id) {
        timeouts.delete(id);
      },
      setInterval(handler) {
        const id = next++;
        intervals.set(id, handler);
        return id;
      },
      clearInterval(id) {
        intervals.delete(id);
      },
      requestAnimationFrame(callback) {
        const id = next++;
        frames.set(id, callback);
        return id;
      },
      cancelAnimationFrame(id) {
        frames.delete(id);
      },
    },
    pending: () => ({ timeouts: timeouts.size, intervals: intervals.size, frames: frames.size }),
    fire(id) {
      const handler = timeouts.get(id);
      timeouts.delete(id);
      handler?.();
    },
  };
}

type Listening = Readonly<{
  target: FeelEventTarget;
  count: () => number;
  captureOnly: () => boolean;
  emit: (type: string, event: unknown) => void;
}>;

function fakeTarget(): Listening {
  type Entry = { type: string; callback: EventListenerOrEventListenerObject | null; options?: AddEventListenerOptions | boolean };
  const listeners: Entry[] = [];
  const target: FeelEventTarget = {
    addEventListener(type, callback, options) {
      listeners.push({ type, callback, options: options as AddEventListenerOptions | boolean | undefined });
    },
    removeEventListener(type, callback) {
      const at = listeners.findIndex((entry) => entry.type === type && entry.callback === callback);
      if (at >= 0) listeners.splice(at, 1);
    },
  };
  return {
    target,
    count: () => listeners.length,
    captureOnly: () => listeners.every((entry) => typeof entry.options === "object" && entry.options?.capture === true),
    emit(type, event) {
      for (const entry of [...listeners]) {
        if (entry.type !== type) continue;
        const callback = entry.callback;
        if (typeof callback === "function") (callback as unknown as (value: unknown) => void)(event);
        else callback?.handleEvent(event as Event);
      }
    },
  };
}

function node(selectors: readonly string[], attributes: Readonly<Record<string, string>> = {}, tagName = "BUTTON"): FeelNode {
  const own = new Set(selectors);
  const self: FeelNode = {
    tagName,
    matches: (list) => list.split(",").some((part) => own.has(part.trim())),
    closest: (list) => (self.matches(list) ? self : null),
    getAttribute: (name) => attributes[name] ?? null,
  };
  return self;
}

test("an event target is only asked the press rule's questions when it can answer them", () => {
  assert.equal(isFeelNode(node(["button"])), true);
  assert.equal(isFeelNode(null), false);
  assert.equal(isFeelNode(undefined), false);
  assert.equal(isFeelNode("button"), false);
  // A document or a window reaches a capture listener too, and has no `matches`.
  assert.equal(isFeelNode({ tagName: "BUTTON" }), false);
  assert.equal(isFeelNode({}), false);
});

test("the layer installs three delegated capture listeners, and no more", () => {
  const harness = fakeHost();
  const listening = fakeTarget();
  const scope = new FeelScope(harness.host);
  mountFeelCues({ target: listening.target, scope, play: () => undefined });
  assert.equal(listening.count(), 3, "pointerdown, keydown, click — not 134 opt-ins");
  assert.equal(listening.captureOnly(), true, "the layer answers before the page's own handler");
  assert.equal(scope.active().listeners, 3);
  scope.stop();
  assert.equal(listening.count(), 0);
});

test("the delegated listeners play the gate's cues, and nothing else", () => {
  const harness = fakeHost();
  const listening = fakeTarget();
  const scope = new FeelScope(harness.host);
  const played: FeelSignal[] = [];
  mountFeelCues({ target: listening.target, scope, play: (signal) => played.push(signal) });

  listening.emit("pointerdown", { button: 0, target: node(["button"]) });
  assert.deepEqual(played, [{ kind: "tap" }]);

  played.length = 0;
  listening.emit("pointerdown", { button: 2, target: node(["button"]) });
  listening.emit("pointerdown", { button: 0, target: node(["input"], {}, "INPUT") });
  listening.emit("pointerdown", { button: 0, target: null });
  listening.emit("pointerdown", { button: 0, target: "not a node" });
  assert.deepEqual(played, [], "a right button, a field and a target that is not an element are all silent");

  listening.emit("keydown", { key: "Enter", repeat: false, target: node(["button"]) });
  listening.emit("keydown", { key: "Enter", repeat: true, target: node(["button"]) });
  listening.emit("keydown", { key: "Tab", repeat: false, target: node(["button"]) });
  assert.deepEqual(played, [{ kind: "tap" }], "Enter presses once; a repeat and Tab do not");

  played.length = 0;
  listening.emit("click", { target: node(["button", '[role="switch"]'], { "aria-checked": "true" }) });
  listening.emit("click", { target: node(["button", "[aria-expanded]"], { "aria-expanded": "false" }) });
  listening.emit("click", { target: node(["button"]) });
  assert.deepEqual(played, [{ kind: "toggle", on: false }, { kind: "expand" }], "a plain button's click adds nothing to its press");
  scope.stop();
});

test("R3-12: every press and key reports a gesture before its cue, so the first press of a session can already be heard", () => {
  const harness = fakeHost();
  const listening = fakeTarget();
  const scope = new FeelScope(harness.host);
  const log: string[] = [];
  mountFeelCues({
    target: listening.target,
    scope,
    gesture: () => log.push("gesture"),
    play: (signal) => log.push(signal.kind),
  });
  listening.emit("pointerdown", { button: 0, target: node(["button"]) });
  assert.deepEqual(log, ["gesture", "tap"]);
  // A press on nothing pressable, or a key on nothing, is still the reader's gesture.
  log.length = 0;
  listening.emit("pointerdown", { button: 0, target: null });
  listening.emit("keydown", { key: "a", repeat: false, target: node(["input"], {}, "INPUT") });
  assert.deepEqual(log, ["gesture", "gesture"]);
  // A click is not reported as a gesture: its own press already was.
  log.length = 0;
  listening.emit("click", { target: node(["button", '[role="switch"]'], { "aria-checked": "false" }) });
  assert.deepEqual(log, ["toggle"]);
  scope.stop();
});

test("a one-shot timer and a frame deregister themselves when they run", () => {
  const harness = fakeHost();
  const scope = new FeelScope(harness.host);
  let ran = 0;
  const id = scope.after(() => {
    ran += 1;
  }, 220);
  assert.equal(scope.active().timers, 1);
  harness.fire(id);
  assert.equal(ran, 1);
  assert.equal(scope.active().timers, 0, "the timer is gone before the handler runs, as bxAfter does");
  scope.stop();
});

test("a stopped scope takes everything with it and refuses new work", () => {
  const harness = fakeHost();
  const listening = fakeTarget();
  const scope = new FeelScope(harness.host);
  scope.after(() => undefined, 220);
  scope.every(() => undefined, 650);
  scope.raf(() => undefined);
  scope.on(listening.target, "pointerup", () => undefined);
  let removed = 0;
  scope.own({
    remove() {
      removed += 1;
    },
  });
  assert.deepEqual(scope.active(), { timers: 2, frames: 1, listeners: 1, nodes: 1 });

  scope.stop();
  assert.deepEqual(scope.active(), { timers: 0, frames: 0, listeners: 0, nodes: 0 });
  assert.deepEqual(harness.pending(), { timeouts: 0, intervals: 0, frames: 0 });
  assert.equal(listening.count(), 0);
  assert.equal(removed, 1, "a ball still in flight leaves with the surface");

  // A callback that lands after the stop cannot resurrect anything.
  assert.equal(scope.after(() => undefined, 1), 0);
  assert.equal(scope.raf(() => undefined), 0);
  assert.equal(scope.every(() => undefined, 1), 0);
  scope.on(listening.target, "click", () => undefined);
  assert.deepEqual(scope.active(), { timers: 0, frames: 0, listeners: 0, nodes: 0 });
  assert.equal(listening.count(), 0, "a listener attached after the stop is never attached");
  let lateRemoved = 0;
  scope.own({
    remove() {
      lateRemoved += 1;
    },
  });
  assert.equal(lateRemoved, 1, "a node handed to a stopped scope is removed at once");

  scope.stop();
  assert.equal(removed, 1, "stopping twice is safe and does not re-remove");
  assert.equal(scope.stopped, true);
});

test("clear and the disposers are idempotent, so a double teardown cannot double-remove", () => {
  const harness = fakeHost();
  const listening = fakeTarget();
  const scope = new FeelScope(harness.host);
  const id = scope.after(() => undefined, 220);
  scope.clear(id);
  scope.clear(id);
  scope.clear(null);
  scope.clear(undefined);
  scope.clear(0);
  assert.equal(scope.active().timers, 0);

  const off = scope.on(listening.target, "pointermove", () => undefined);
  off();
  off();
  assert.equal(listening.count(), 0);
  assert.equal(scope.active().listeners, 0);

  let removed = 0;
  const release = scope.own({
    remove() {
      removed += 1;
    },
  });
  release();
  release();
  assert.equal(removed, 1);
  scope.stop();
});

test("the gate's own leak check: 20 mounts and unmounts leave 0 timers, 0 frames, 0 listeners and 0 nodes", () => {
  const baseline = feelActive();
  const harness = fakeHost();
  const listening = fakeTarget();
  const listenersBefore = listening.count();
  let nodesRemoved = 0;

  for (let cycle = 0; cycle < 20; cycle += 1) {
    const scope = new FeelScope(harness.host);
    mountFeelCues({ target: listening.target, scope, play: () => undefined });

    // A press, armed and stepping, with the window listeners a live hold adds.
    scope.on(listening.target, "pointermove", () => undefined);
    scope.on(listening.target, "pointerup", () => undefined);
    scope.on(listening.target, "pointercancel", () => undefined);
    scope.on(listening.target, "keydown", () => undefined);
    scope.after(() => undefined, 220);
    scope.after(() => undefined, 650);
    // The click swallow's fallback, and a frame.
    scope.after(() => undefined, 400);
    scope.raf(() => undefined);
    // A ball mid-flight.
    scope.own({
      remove() {
        nodesRemoved += 1;
      },
    });

    // Real traffic over the delegated listeners while all that is outstanding.
    listening.emit("pointerdown", { button: 0, target: node(["button"]) });
    listening.emit("keydown", { key: "Escape", repeat: false, target: node(["button"]) });
    listening.emit("click", { target: node(["button"]) });

    assert.equal(scope.active().timers, 3, `cycle ${cycle}: three timers outstanding`);
    assert.equal(scope.active().listeners, 7, `cycle ${cycle}: three delegated plus four for the hold`);

    // The unmount.
    scope.stop();
  }

  const after = feelActive();
  assert.deepEqual(
    { scopes: after.scopes - baseline.scopes, timers: after.timers, frames: after.frames, listeners: after.listeners, nodes: after.nodes },
    { scopes: 0, timers: 0, frames: 0, listeners: 0, nodes: 0 },
    "feelActive() is the countable bxActive(): zero on every count",
  );
  assert.deepEqual(harness.pending(), { timeouts: 0, intervals: 0, frames: 0 }, "the host has nothing left scheduled");
  assert.equal(listening.count(), listenersBefore, "the same listener count as before the 20 cycles");
  assert.equal(nodesRemoved, 20, "every ball left with its surface");
});

test("feelActive counts across every live scope and forgets the stopped ones", () => {
  const baseline = feelActive();
  const harness = fakeHost();
  const one = new FeelScope(harness.host);
  const two = new FeelScope(harness.host);
  one.after(() => undefined, 1);
  two.raf(() => undefined);
  const now = feelActive();
  assert.equal(now.scopes - baseline.scopes, 2);
  assert.equal(now.timers - baseline.timers, 1);
  assert.equal(now.frames - baseline.frames, 1);
  one.stop();
  two.stop();
  const end = feelActive();
  assert.equal(end.scopes - baseline.scopes, 0);
  assert.equal(end.timers, 0);
  assert.equal(end.frames, 0);
});
