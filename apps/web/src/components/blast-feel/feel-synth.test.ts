import assert from "node:assert/strict";
import test from "node:test";

import { FEEL_ATTACK_MS, FEEL_MASTER_GAIN, FEEL_RELEASE_TAIL_MS } from "./feel-cues.ts";
import { FeelSynth, type FeelAudioContext, type FeelAudioParam, type FeelGainNode, type FeelOscillatorNode } from "./feel-synth.ts";

/**
 * OA-23 / FEEL-LAYER.md §1: the synth. The rules it has to keep are that no
 * audio object exists until a cue follows a real gesture (audio is opt-in and
 * never autoplays), that each note is scheduled exactly as the gate schedules
 * it, and that nothing it does can break the action it followed.
 */

type Ramp = Readonly<{ kind: "set" | "linear" | "exp"; value: number; at: number }>;

type FakeOscillator = FeelOscillatorNode & { ramps: Ramp[]; started: number | null; stopped: number | null; connected: unknown[] };

function param(ramps: Ramp[]): FeelAudioParam {
  return {
    value: 0,
    setValueAtTime(value, at) {
      ramps.push({ kind: "set", value, at });
    },
    linearRampToValueAtTime(value, at) {
      ramps.push({ kind: "linear", value, at });
    },
    exponentialRampToValueAtTime(value, at) {
      ramps.push({ kind: "exp", value, at });
    },
  };
}

function fakeContext(options: Readonly<{ state?: string; now?: number; failOscillator?: boolean }> = {}) {
  const oscillators: FakeOscillator[] = [];
  const gains: (FeelGainNode & { ramps: Ramp[]; connected: unknown[] })[] = [];
  let closed = 0;
  let resumed = 0;
  let state = options.state ?? "running";
  const destination: FeelAudioContext["destination"] = { connect: () => undefined, disconnect: () => undefined };
  const context: FeelAudioContext = {
    currentTime: options.now ?? 10,
    get state() {
      return state;
    },
    destination,
    createGain() {
      const ramps: Ramp[] = [];
      const connected: unknown[] = [];
      const gain: FeelGainNode & { ramps: Ramp[]; connected: unknown[] } = {
        gain: param(ramps),
        ramps,
        connected,
        connect(to) {
          connected.push(to);
          return undefined;
        },
        disconnect: () => undefined,
      };
      gains.push(gain);
      return gain;
    },
    createOscillator() {
      if (options.failOscillator) throw new Error("no oscillators here");
      const ramps: Ramp[] = [];
      const connected: unknown[] = [];
      const osc: FakeOscillator = {
        type: "sine",
        frequency: param(ramps),
        ramps,
        connected,
        started: null,
        stopped: null,
        connect(to) {
          connected.push(to);
          return undefined;
        },
        disconnect: () => undefined,
        start(when) {
          osc.started = when;
          return undefined;
        },
        stop(when) {
          osc.stopped = when;
          return undefined;
        },
      };
      oscillators.push(osc);
      return osc;
    },
    resume() {
      resumed += 1;
      state = "running";
      return undefined;
    },
    close() {
      closed += 1;
      return undefined;
    },
  };
  return {
    context,
    oscillators,
    gains,
    get closed() {
      return closed;
    },
    get resumed() {
      return resumed;
    },
  };
}

test("nothing autoplays: with sound off no audio context is ever created", () => {
  let built = 0;
  const synth = new FeelSynth(() => {
    built += 1;
    return fakeContext().context;
  });
  assert.equal(synth.enabled, false, "sound starts off");
  for (const kind of ["tap", "land", "chord", "error"] as const) synth.play({ kind });
  assert.equal(built, 0, "no AudioContext was constructed");
  assert.equal(synth.started, false);
  synth.dispose();
});

test("the context is built on the first cue after sound is turned on, and only once", () => {
  const fake = fakeContext();
  let built = 0;
  const synth = new FeelSynth(() => {
    built += 1;
    return fake.context;
  });
  synth.setEnabled(true);
  assert.equal(built, 0, "turning sound on does not build it either");
  synth.play({ kind: "tap" });
  assert.equal(built, 1);
  assert.equal(synth.started, true);
  synth.play({ kind: "tap" });
  assert.equal(built, 1, "one context for the page");
  // One master gain at the gate's level, into the destination.
  const master = fake.gains[0]!;
  assert.equal(master.gain.value, FEEL_MASTER_GAIN);
  assert.equal(master.connected[0], fake.context.destination);
  synth.dispose();
});

test("a tap is scheduled exactly as the gate schedules it", () => {
  const fake = fakeContext({ now: 4 });
  const synth = new FeelSynth(() => fake.context, true);
  synth.play({ kind: "tap" });
  assert.equal(fake.oscillators.length, 1);
  const osc = fake.oscillators[0]!;
  assert.equal(osc.type, "triangle");
  assert.deepEqual(osc.ramps, [{ kind: "set", value: 880, at: 4 }], "no glide on a tap");
  assert.equal(osc.started, 4);
  assert.equal(osc.stopped, 4 + 0.045 + FEEL_RELEASE_TAIL_MS / 1000);
  // Attack to the note's gain, then an exponential decay to silence.
  const note = fake.gains[1]!;
  assert.deepEqual(note.ramps, [
    { kind: "set", value: 0, at: 4 },
    { kind: "linear", value: 0.12, at: 4 + FEEL_ATTACK_MS / 1000 },
    { kind: "exp", value: 0.0001, at: 4.045 },
  ]);
  // Oscillator → its own gain → the master gain.
  assert.equal(osc.connected[0], note);
  assert.equal(note.connected[0], fake.gains[0]);
  synth.dispose();
});

test("a glide bends the pitch over the note, and a phrase keeps its offsets", () => {
  const fake = fakeContext({ now: 0 });
  const synth = new FeelSynth(() => fake.context, true);
  synth.play({ kind: "fire" });
  assert.deepEqual(fake.oscillators[0]!.ramps, [
    { kind: "set", value: 260, at: 0 },
    { kind: "exp", value: 260 * 2.6, at: 0.2 },
  ]);
  synth.play({ kind: "land" });
  assert.equal(fake.oscillators.length, 3);
  assert.equal(fake.oscillators[1]!.started, 0);
  assert.equal(fake.oscillators[2]!.started, 0.045, "the second note of the landing is 45 ms later");
  synth.dispose();
});

test("a suspended context is resumed, because the first cue follows a real gesture", () => {
  const fake = fakeContext({ state: "suspended" });
  const synth = new FeelSynth(() => fake.context, true);
  synth.play({ kind: "tap" });
  synth.play({ kind: "tap" });
  assert.ok(fake.resumed >= 1, "resume was asked for");
  synth.dispose();
});

test("turning sound off silences the current phrase and future notes", () => {
  const fake = fakeContext();
  const synth = new FeelSynth(() => fake.context, true);
  synth.play({ kind: "tap" });
  synth.setEnabled(false);
  assert.equal(fake.gains[0]!.gain.value, 0);
  synth.play({ kind: "tap" });
  assert.equal(fake.oscillators.length, 1);
  assert.equal(fake.closed, 0, "a reader who turns it straight back on keeps the same context");
  synth.setEnabled(true);
  assert.equal(fake.gains[0]!.gain.value, FEEL_MASTER_GAIN);
  synth.play({ kind: "tap" });
  assert.equal(fake.oscillators.length, 2);
  synth.dispose();
});

test("dispose closes the context and the synth stays silent afterwards", () => {
  const fake = fakeContext();
  const synth = new FeelSynth(() => fake.context, true);
  synth.play({ kind: "tap" });
  synth.dispose();
  assert.equal(fake.closed, 1);
  assert.equal(synth.enabled, false);
  synth.play({ kind: "tap" });
  assert.equal(fake.oscillators.length, 1, "nothing plays after dispose");
  synth.dispose();
  assert.equal(fake.closed, 1, "disposing twice is safe");
});

test("sound never breaks the action: no audio, or audio that throws, is survivable", () => {
  const none = new FeelSynth(() => null, true);
  none.play({ kind: "chord" });
  assert.equal(none.started, false);
  none.dispose();

  const broken = new FeelSynth(() => fakeContext({ failOscillator: true }).context, true);
  broken.play({ kind: "claim" });
  broken.dispose();

  const throwing = new FeelSynth(() => {
    throw new Error("blocked");
  }, true);
  throwing.play({ kind: "tap" });
  assert.equal(throwing.started, false, "a factory that throws leaves the page quiet, not broken");
  throwing.dispose();
});
