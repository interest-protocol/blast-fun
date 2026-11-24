import assert from "node:assert/strict";
import test from "node:test";

import type { FeelNode, FeelSignal } from "./feel-cues.ts";
import { runHeldRelease } from "./feel-hold-release.ts";
import { startFeelAudio } from "./feel-mount.ts";
import { FeelScope, type FeelEventTarget, type FeelScopeHost } from "./feel-scope.ts";
import {
  adoptAccountSound,
  FEEL_SOUND_KEY,
  motionAllowed,
  resetSoundEnabledCache,
  setSoundEnabled,
  soundChangeMark,
} from "./feel-sound-pref.ts";
import type { FeelAudioContext, FeelAudioParam } from "./feel-synth.ts";

/**
 * Sound is off until the reader turns it on (the owner, 2026-10-06, amending
 * OA-25 Q3a), and while it is off nothing plays and **no audio context is
 * created or resumed** — on the first paint, after a sign-in whose account
 * has not chosen, and under reduced motion.
 *
 * Proved over the provider's own audio path (`startFeelAudio`: the synth
 * following the flag, the gate, the delegated listeners) with a recording
 * `AudioContext` factory, driving every way a cue reaches it: the page-wide
 * press, key and click listeners; every signal a surface plays through the
 * provider (the commit's `land`/`error`, the celebration's `chord`, a sheet's
 * `open`/`close`, the hold's `tick`s); and a held blast's release, with and
 * without motion.
 */

const EVERY_SIGNAL: readonly FeelSignal[] = [
  { kind: "curve-buy" },
  { kind: "curve-sell" },
  { kind: "tap" },
  { kind: "tick", level: 0 },
  { kind: "tick", level: 5 },
  { kind: "fire" },
  { kind: "land" },
  { kind: "claim" },
  { kind: "chord" },
  { kind: "error" },
  { kind: "open" },
  { kind: "close" },
  { kind: "expand" },
  { kind: "collapse" },
  { kind: "toggle", on: true },
  { kind: "toggle", on: false },
  { kind: "follow", on: true },
  { kind: "follow", on: false },
];

function recorder() {
  const log = { built: 0, resumed: 0, notes: 0, state: "running" };
  const param = (): FeelAudioParam => ({
    value: 0,
    setValueAtTime: () => undefined,
    linearRampToValueAtTime: () => undefined,
    exponentialRampToValueAtTime: () => undefined,
  });
  const node = () => ({ connect: () => undefined, disconnect: () => undefined });
  const factory = (): FeelAudioContext => {
    log.built += 1;
    return {
      currentTime: 0,
      get state() {
        return log.state;
      },
      destination: node(),
      createGain: () => ({ ...node(), gain: param() }),
      createOscillator: () => {
        log.notes += 1;
        return { ...node(), type: "sine", frequency: param(), start: () => undefined, stop: () => undefined };
      },
      resume: () => {
        log.resumed += 1;
        log.state = "running";
      },
      close: () => undefined,
    };
  };
  return { log, factory };
}

function listening() {
  const listeners: { type: string; callback: EventListenerOrEventListenerObject | null }[] = [];
  const target: FeelEventTarget = {
    addEventListener(type, callback) {
      listeners.push({ type, callback });
    },
    removeEventListener(type, callback) {
      const at = listeners.findIndex((entry) => entry.type === type && entry.callback === callback);
      if (at >= 0) listeners.splice(at, 1);
    },
  };
  const emit = (type: string, event: unknown) => {
    for (const entry of [...listeners]) {
      if (entry.type === type && typeof entry.callback === "function") (entry.callback as unknown as (value: unknown) => void)(event);
    }
  };
  return { target, emit };
}

const NO_TIMERS: FeelScopeHost = {
  setTimeout: () => 0,
  clearTimeout: () => undefined,
  setInterval: () => 0,
  clearInterval: () => undefined,
  requestAnimationFrame: () => 0,
  cancelAnimationFrame: () => undefined,
};

function node(selectors: readonly string[], attributes: Readonly<Record<string, string>> = {}): FeelNode {
  const own = new Set(selectors);
  const self: FeelNode = {
    tagName: "BUTTON",
    matches: (list) => list.split(",").some((part) => own.has(part.trim())),
    closest: (list) => (self.matches(list) ? self : null),
    getAttribute: (name) => attributes[name] ?? null,
  };
  return self;
}

/** A page on a device: `localStorage` holding `stored`, `prefers-reduced-motion` as given, a storage event to fire. */
function page(stored: Readonly<Record<string, string>> = {}, reducedMotion = false) {
  const values = new Map(Object.entries(stored));
  const storageListeners = new Set<(event: { key: string | null }) => void>();
  (globalThis as { window?: unknown }).window = {
    localStorage: { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => void values.set(key, value) },
    addEventListener: (type: string, listener: (event: { key: string | null }) => void) => {
      if (type === "storage") storageListeners.add(listener);
    },
    removeEventListener: (type: string, listener: (event: { key: string | null }) => void) => storageListeners.delete(listener),
    matchMedia: () => ({ matches: reducedMotion }),
  };
  resetSoundEnabledCache();
  const { log, factory } = recorder();
  const events = listening();
  const scope = new FeelScope(NO_TIMERS);
  const clock = { now: 10_000 };
  const audio = startFeelAudio({ target: events.target, scope, audioContext: factory, now: () => clock.now, visible: () => true });
  /** Another tab wrote `blast.sound`. */
  const otherTab = (value: boolean) => {
    values.set(FEEL_SOUND_KEY, JSON.stringify(value));
    for (const listener of storageListeners) listener({ key: FEEL_SOUND_KEY });
  };
  const close = () => {
    scope.stop();
    audio.dispose();
  };
  return { log, events, audio, clock, otherTab, close };
}

test.after(() => {
  delete (globalThis as { window?: unknown }).window;
});

/** Everything that can ask for a sound, each one a fresh event (so no cap is what keeps it quiet). */
async function everyCue(rig: ReturnType<typeof page>): Promise<void> {
  const { events, audio, clock } = rig;
  const step = () => {
    clock.now += 1_000;
  };
  // The page-wide listeners: a press, a key, a switch, a disclosure, a follow.
  events.emit("pointerdown", { button: 0, target: node(["button"]) });
  step();
  events.emit("keydown", { key: "Enter", repeat: false, target: node(["button"]) });
  step();
  events.emit("pointerdown", { button: 0, target: node(["button", '[role="switch"]'], { "aria-checked": "false" }) });
  events.emit("click", { target: node(["button", '[role="switch"]'], { "aria-checked": "false" }) });
  events.emit("click", { target: node(["button", "[aria-expanded]"], { "aria-expanded": "false" }) });
  events.emit("click", { target: node(["button", "[data-feel-follow]"], { "aria-pressed": "false" }) });
  // Every signal a surface plays through the provider, plain and as a fresh cue right after a gesture.
  for (const signal of EVERY_SIGNAL) {
    step();
    events.emit("pointerdown", { button: 0, target: null });
    audio.play(signal);
    audio.play(signal, { fresh: true });
  }
  // A held blast's release: refused, committed and failed, as motion allows it here.
  for (const quote of [() => "Sale closed.", () => null]) {
    for (const commit of [async () => undefined, async () => Promise.reject(new Error("x"))]) {
      step();
      await runHeldRelease({
        amountUsd: 50,
        play: (signal) => audio.play(signal),
        motion: motionAllowed(),
        quote,
        landing: () => ({ x: 1, y: 1 }),
        shake: async () => undefined,
        fly: async () => undefined,
        flash: () => undefined,
        commit,
        refused: () => undefined,
      });
    }
  }
}

test("OA-33: on the first paint with no choice stored, nothing sounds and no AudioContext is created", async () => {
  const rig = page();
  await everyCue(rig);
  assert.deepEqual(rig.log, { built: 0, resumed: 0, notes: 0, state: "running" });
  rig.close();
});

test("OA-33: after a sign-in whose account has not chosen, sound stays off and nothing is built", async () => {
  const rig = page();
  assert.equal(adoptAccountSound(null, soundChangeMark()), null);
  await everyCue(rig);
  assert.equal(rig.log.built, 0);
  assert.equal(rig.log.notes, 0);
  rig.close();
});

test("OA-33: a stored off is kept, under reduced motion too — motion is never what turns sound on or off", async () => {
  const rig = page({ [FEEL_SOUND_KEY]: "false" }, true);
  assert.equal(motionAllowed(), false, "reduced motion is on");
  await everyCue(rig);
  assert.deepEqual([rig.log.built, rig.log.resumed, rig.log.notes], [0, 0, 0]);
  rig.close();
});

test("OA-33: turned on with a switch, it plays from then on (under reduced motion too); turned off, nothing new plays and the context is never resumed", async () => {
  const rig = page({}, true);
  // The switch: its press is the reader's gesture, and turning it on confirms with one tap (the provider's `set`).
  rig.events.emit("pointerdown", { button: 0, target: node(["button", '[role="switch"]'], { "aria-checked": "false" }) });
  setSoundEnabled(true);
  rig.audio.play({ kind: "tap" });
  assert.deepEqual([rig.log.built, rig.log.notes], [1, 1], "the context is built by the confirming tap, inside the gesture");
  await everyCue(rig);
  assert.ok(rig.log.notes > 1, "every path sounds once it is on, including a held blast under reduced motion");
  assert.equal(rig.log.built, 1, "one context for the page");

  // Off again: the browser has suspended the idle context in the meantime.
  const notes = rig.log.notes;
  setSoundEnabled(false);
  rig.log.state = "suspended";
  await everyCue(rig);
  assert.deepEqual([rig.log.notes, rig.log.resumed], [notes, 0], "nothing new, and no resume");

  // On again from the account's explicit choice (another device) — and off from another tab.
  adoptAccountSound(true, soundChangeMark());
  rig.audio.play({ kind: "land" });
  assert.equal(rig.log.resumed, 1, "a cue that may sound resumes it");
  assert.equal(rig.log.notes, notes + 2);
  rig.otherTab(false);
  rig.log.state = "suspended";
  await everyCue(rig);
  assert.deepEqual([rig.log.notes, rig.log.resumed], [notes + 2, 1], "off in another tab is off here at once");
  rig.close();
});
