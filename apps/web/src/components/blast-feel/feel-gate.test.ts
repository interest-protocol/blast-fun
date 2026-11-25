import assert from "node:assert/strict";
import test from "node:test";

import { voicesFor, type FeelSignal } from "./feel-cues.ts";
import { FEEL_FRESH_GESTURE_MS, FEEL_MONEY_EVENT_MS, FEEL_TAP_MIN_GAP_MS, FeelGate, gatedPlay } from "./feel-gate.ts";
import { FeelSynth, type FeelAudioContext, type FeelAudioParam } from "./feel-synth.ts";

/**
 * R3-12's product rules, in front of the synth: nothing before the first
 * gesture (and no `AudioContext` either), nothing while hidden, one press tap
 * per 60 ms, one money sound per event, and a fresh cue only near a gesture.
 *
 * The recorder below is the "Web Audio destination stubbed by a recorder that
 * logs each scheduled tone's frequency, duration and start time" the ticket's
 * criteria name: every oscillator the synth starts is logged as
 * `{ hz, ms, at }`, plus the constructor's calls.
 */

type Tone = Readonly<{ hz: number; ms: number; at: number; wave: string; gain: number; glideTo: number | null }>;

function recorder(clock: { now: number }) {
  const tones: Tone[] = [];
  let constructed = 0;
  const param = (onSet: (value: number, at: number) => void, onExp?: (value: number, at: number) => void): FeelAudioParam => ({
    value: 0,
    setValueAtTime: (value, at) => onSet(value, at),
    linearRampToValueAtTime: () => undefined,
    exponentialRampToValueAtTime: (value, at) => onExp?.(value, at),
  });
  const factory = (): FeelAudioContext => {
    constructed += 1;
    const destination = { connect: () => undefined, disconnect: () => undefined };
    return {
      get currentTime() {
        return clock.now / 1000;
      },
      state: "running",
      destination,
      createGain() {
        let peak = 0;
        const gain = {
          gain: param(
            () => undefined,
            () => undefined,
          ),
          connect: () => undefined,
          disconnect: () => undefined,
        };
        gain.gain.linearRampToValueAtTime = (value: number) => {
          peak = value;
          return undefined;
        };
        Object.defineProperty(gain, "peak", { get: () => peak });
        return gain;
      },
      createOscillator() {
        let hz = 0;
        let at = 0;
        let glideTo: number | null = null;
        let gainNode: { peak?: number } | null = null;
        const osc = {
          type: "sine" as OscillatorType,
          frequency: param(
            (value, when) => {
              hz = value;
              at = when;
            },
            (value) => {
              glideTo = value;
            },
          ),
          connect(to: unknown) {
            gainNode = to as { peak?: number };
            return undefined;
          },
          disconnect: () => undefined,
          start: () => undefined,
          stop(when: number) {
            tones.push({
              hz,
              at: Math.round(at * 1_000_000) / 1000,
              // The coded duration: the synth stops 30 ms after the decay.
              ms: Math.round((when - at) * 1_000_000) / 1000 - 30,
              wave: osc.type,
              gain: gainNode?.peak ?? 0,
              glideTo,
            });
            return undefined;
          },
        };
        return osc;
      },
      resume: () => undefined,
      close: () => undefined,
    };
  };
  return {
    factory,
    tones,
    get constructed() {
      return constructed;
    },
  };
}

function rig(options: Readonly<{ visible?: () => boolean }> = {}) {
  const clock = { now: 1_000 };
  const record = recorder(clock);
  const synth = new FeelSynth(record.factory, true);
  const gate = new FeelGate(() => clock.now, options.visible ?? (() => true));
  const play = (signal: FeelSignal, fresh = false) => gatedPlay(synth, gate, signal, fresh ? { fresh: true } : undefined);
  return { clock, record, synth, gate, play };
}

test("R3-12-AC-3: nothing is scheduled and no AudioContext is constructed before the first gesture, even by a money result", () => {
  const { record, gate, play } = rig();
  // A cold load, a scroll (no gesture is reported for one), a commit landing, a celebration.
  for (const kind of ["tap", "land", "chord", "error", "claim", "open"] as const) play({ kind });
  play({ kind: "tick", level: 2 });
  assert.equal(record.constructed, 0, "the constructor was never called");
  assert.deepEqual(record.tones, []);
  assert.equal(gate.refusal({ kind: "land" }), "no-gesture");
  // The first press: now it may sound, and the context is built inside that gesture.
  gate.gesture();
  play({ kind: "tap" });
  assert.equal(record.constructed, 1);
  assert.equal(record.tones.length, 1);
});

test("R3-12-AC-6: nothing is scheduled while the document is hidden, and it sounds again once visible", () => {
  let visible = true;
  const { record, gate, play } = rig({ visible: () => visible });
  gate.gesture();
  visible = false;
  play({ kind: "land" });
  play({ kind: "chord" });
  play({ kind: "tap" });
  assert.deepEqual(record.tones, []);
  assert.equal(gate.refusal({ kind: "land" }), "hidden");
  visible = true;
  play({ kind: "land" });
  assert.equal(record.tones.length, 2, "the landing's two notes");
});

test("R3-12-AC-11: twenty presses in 200 ms schedule at most four taps", () => {
  const { clock, record, gate, play } = rig();
  for (let n = 0; n < 20; n += 1) {
    clock.now = 1_000 + n * 10;
    gate.gesture();
    play({ kind: "tap" });
  }
  const taps = record.tones.filter((tone) => tone.hz === 880);
  assert.ok(taps.length <= 4, `${taps.length} taps`);
  assert.equal(taps.length, 4, "0, 60, 120 and 180 ms");
  assert.equal(FEEL_TAP_MIN_GAP_MS, 60);
  // The cap is on taps only: a switch in the same burst still answers.
  play({ kind: "toggle", on: true });
  assert.equal(record.tones.at(-1)!.hz, 740);
});

test("Curve trades sound in opposite directions and share a single burst limit", () => {
  const { clock, record, gate, play } = rig();
  gate.gesture();
  play({ kind: "curve-buy" });
  clock.now += 1_199;
  assert.equal(gate.refusal({ kind: "curve-sell" }), "trade-rate");
  play({ kind: "curve-sell" });
  assert.equal(record.tones.length, 1);
  clock.now += 1;
  play({ kind: "curve-sell" });
  assert.deepEqual(record.tones.map(({ hz, glideTo }) => [hz, glideTo]), [[590, 590 * 1.32], [590, 590 * 0.72]]);
  assert.ok(voicesFor({ kind: "curve-buy" })[0]!.gain < voicesFor({ kind: "tap" })[0]!.gain);
});

test("R3-12: one money sound per event — the same result reported twice sounds once; a different one, or a later one, sounds", () => {
  const { clock, record, gate, play } = rig();
  gate.gesture();
  play({ kind: "land" });
  play({ kind: "land" }, false);
  assert.equal(record.tones.filter((tone) => tone.hz === 659.25).length, 1, "two reports of one landing");
  play({ kind: "error" });
  assert.equal(record.tones.filter((tone) => tone.hz === 220).length, 1, "a different money sound is its own event");
  clock.now += FEEL_MONEY_EVENT_MS;
  play({ kind: "land" });
  assert.equal(record.tones.filter((tone) => tone.hz === 659.25).length, 2, "the next commit lands again");
});

test("R3-12: a fresh cue (a sheet opening) needs a gesture within a second; a money result does not", () => {
  const { clock, record, gate, play } = rig();
  gate.gesture();
  play({ kind: "open" }, true);
  assert.equal(record.tones.length, 1, "a sheet the reader opened glides open");
  clock.now += FEEL_FRESH_GESTURE_MS + 1;
  play({ kind: "close" }, true);
  play({ kind: "open" }, true);
  assert.equal(record.tones.length, 1, "a sheet that closes after a long signature, or opens on its own, is silent");
  assert.equal(gate.refusal({ kind: "open" }, { fresh: true }), "stale");
  play({ kind: "land" });
  assert.equal(record.tones.length, 3, "the commit's landing, seconds after the press, still sounds");
});

test("R3-12: a cue sound would not play anyway (sound off) never counts against the caps", () => {
  const { record, synth, gate, play } = rig();
  gate.gesture();
  synth.setEnabled(false);
  play({ kind: "tap" });
  play({ kind: "land" });
  synth.setEnabled(true);
  play({ kind: "tap" });
  play({ kind: "land" });
  assert.equal(record.tones.filter((tone) => tone.hz === 880).length, 1);
  assert.equal(record.tones.filter((tone) => tone.hz === 659.25).length, 1);
});

test("R3-12-AC-2: each of the twelve sounds schedules the table's frequencies, durations and offsets (within 1 ms and 0.01 Hz)", () => {
  const expected: readonly [FeelSignal, readonly (readonly [number, number, number])[]][] = [
    [{ kind: "tap" }, [[880, 45, 0]]],
    [{ kind: "tick", level: 0 }, [[523.25, 80, 0]]],
    [{ kind: "tick", level: 3 }, [[784.875, 80, 0]]],
    [{ kind: "tick", level: 9 }, [[1046.5, 80, 0]]],
    [{ kind: "fire" }, [[260, 200, 0]]],
    [{ kind: "buy" }, [[587.33, 140, 0], [880, 190, 65]]],
    [{ kind: "sell" }, [[783.99, 140, 0], [587.33, 175, 65]]],
    [{ kind: "navigate" }, [[330, 135, 0]]],
    [{ kind: "notification" }, [[1046.5, 225, 0]]],
    [{ kind: "land" }, [[659.25, 240, 0], [987.77, 340, 45]]],
    [{ kind: "claim" }, [[523.25, 260, 0], [659.25, 260, 60], [783.99, 260, 120]]],
    [{ kind: "chord" }, [[523.25, 700, 0], [659.25, 700, 80], [783.99, 700, 160], [1046.5, 700, 240]]],
    [{ kind: "error" }, [[220, 140, 0], [185, 200, 90]]],
    [{ kind: "open" }, [[440, 100, 0]]],
    [{ kind: "close" }, [[560, 100, 0]]],
    [{ kind: "expand" }, [[392, 80, 0]]],
    [{ kind: "collapse" }, [[490, 80, 0]]],
    [{ kind: "toggle", on: true }, [[740, 60, 0]]],
    [{ kind: "toggle", on: false }, [[494, 60, 0]]],
    [{ kind: "follow", on: true }, [[659.25, 140, 0], [987.77, 140, 70]]],
    [{ kind: "follow", on: false }, [[783.99, 140, 0], [523.25, 140, 70]]],
  ];
  for (const [signal, notes] of expected) {
    const { clock, record, gate } = rig();
    gate.gesture();
    const synth = new FeelSynth(record.factory, true);
    synth.play(signal);
    const start = clock.now;
    assert.equal(record.tones.length, notes.length, signal.kind);
    record.tones.forEach((tone, index) => {
      const [hz, ms, at] = notes[index]!;
      assert.ok(Math.abs(tone.hz - hz) <= 0.01, `${signal.kind} note ${index}: ${tone.hz} Hz, expected ${hz}`);
      assert.ok(Math.abs(tone.ms - ms) <= 1, `${signal.kind} note ${index}: ${tone.ms} ms, expected ${ms}`);
      assert.ok(Math.abs(tone.at - (start + at)) <= 1, `${signal.kind} note ${index}: starts at +${tone.at - start} ms, expected +${at}`);
    });
    // The recorder agrees with the table the synth reads.
    assert.equal(voicesFor(signal).length, notes.length);
    synth.dispose();
  }
});

test("R3-12: the gate's glides, waves and levels are the table's (fire ×2.6, open ×1.4, close ×0.7, a triangle tap and switch)", () => {
  const { record, gate } = rig();
  gate.gesture();
  const synth = new FeelSynth(record.factory, true);
  for (const kind of ["fire", "open", "close", "expand", "collapse", "tap"] as const) synth.play({ kind });
  synth.play({ kind: "toggle", on: true });
  const [fire, open, close, expand, collapse, tap, toggle] = record.tones;
  assert.equal(fire!.glideTo, 260 * 2.6);
  assert.equal(open!.glideTo, 440 * 1.4);
  assert.equal(close!.glideTo, 560 * 0.7);
  assert.equal(expand!.glideTo, 392 * 1.25);
  assert.equal(collapse!.glideTo, 490 * 0.8);
  assert.deepEqual([tap!.wave, tap!.gain, tap!.glideTo], ["triangle", 0.12, null]);
  assert.deepEqual([toggle!.wave, toggle!.gain], ["triangle", 0.14]);
  assert.deepEqual([fire!.gain, open!.gain, close!.gain], [0.34, 0.12, 0.1]);
  synth.dispose();
});

test("R3-12-AC-9: an audio failure does not break the action — a constructor that throws leaves every cue a quiet no-op", () => {
  const gate = new FeelGate(() => 0);
  gate.gesture();
  let calls = 0;
  const synth = new FeelSynth(() => {
    calls += 1;
    throw new Error("AudioContext is not allowed");
  }, true);
  for (const kind of ["tap", "land", "claim", "error", "chord"] as const) {
    assert.doesNotThrow(() => gatedPlay(synth, gate, { kind }));
  }
  assert.ok(calls >= 1, "it was asked, and refused");
  assert.equal(synth.started, false);
  synth.dispose();
});
