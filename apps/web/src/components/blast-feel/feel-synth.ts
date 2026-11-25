/**
 * The Feel layer's voice: short, quiet tones generated in the browser, no audio
 * files (FEEL-LAYER.md §1).
 *
 * One `AudioContext`, created **lazily on the first cue and only while sound is
 * on**, so nothing autoplays and a reader who never turns sound on never has an
 * audio context at all. One master gain. Every note is an oscillator plus a
 * gain with a 6 ms linear attack and an exponential decay, stopped 30 ms after
 * the decay so the tail is not clipped.
 *
 * The context factory is injected, so the synth is testable under `node --test`
 * with no Web Audio at all.
 */

import { FEEL_ATTACK_MS, FEEL_MASTER_GAIN, FEEL_RELEASE_TAIL_MS, voicesFor, type FeelSignal, type FeelVoice } from "./feel-cues.ts";

/** The slice of Web Audio the synth uses. The real `AudioContext` satisfies it. */
export type FeelAudioParam = {
  value: number;
  setValueAtTime(value: number, startTime: number): unknown;
  linearRampToValueAtTime(value: number, endTime: number): unknown;
  exponentialRampToValueAtTime(value: number, endTime: number): unknown;
};

export type FeelAudioNode = {
  connect(destination: FeelAudioNode): unknown;
  disconnect(): unknown;
};

export type FeelGainNode = FeelAudioNode & { gain: FeelAudioParam };

export type FeelOscillatorNode = FeelAudioNode & {
  type: OscillatorType;
  frequency: FeelAudioParam;
  start(when: number): unknown;
  stop(when: number): unknown;
};

export type FeelAudioContext = {
  readonly currentTime: number;
  readonly state: string;
  readonly destination: FeelAudioNode;
  createGain(): FeelGainNode;
  createOscillator(): FeelOscillatorNode;
  resume(): unknown;
  close(): unknown;
};

/** Makes a context, or null where Web Audio is missing or refuses. */
export type FeelAudioContextFactory = () => FeelAudioContext | null;

/** The browser's factory; null on the server or where `AudioContext` is absent. */
export const browserAudioContext: FeelAudioContextFactory = () => {
  if (typeof window === "undefined") return null;
  const Ctor = window.AudioContext;
  if (typeof Ctor !== "function") return null;
  try {
    return new Ctor();
  } catch {
    return null;
  }
};

export class FeelSynth {
  readonly #factory: FeelAudioContextFactory;
  #context: FeelAudioContext | null = null;
  #master: FeelGainNode | null = null;
  #enabled: boolean;
  #disposed = false;

  constructor(factory: FeelAudioContextFactory, enabled = false) {
    this.#factory = factory;
    this.#enabled = enabled;
  }

  get enabled(): boolean {
    return this.#enabled;
  }

  /** Whether a context exists yet — the proof that nothing was created before a cue. */
  get started(): boolean {
    return this.#context !== null;
  }

  /**
   * Silence the current phrase and suppress new notes while muted.
   * Keep the context available for the next gesture.
   */
  setEnabled(enabled: boolean): void {
    this.#enabled = enabled;
    if (this.#master) this.#master.gain.value = enabled ? FEEL_MASTER_GAIN : 0;
  }

  /** Plays one signal. A no-op while sound is off, after `dispose`, or with no audio available. */
  play(signal: FeelSignal): void {
    if (!this.#enabled || this.#disposed) return;
    const context = this.#open();
    if (!context || !this.#master) return;
    const start = context.currentTime;
    for (const voice of voicesFor(signal)) this.#note(context, this.#master, voice, start);
  }

  /** Closes the context and drops every node. Safe to call twice. */
  dispose(): void {
    this.#disposed = true;
    this.#enabled = false;
    const master = this.#master;
    const context = this.#context;
    this.#master = null;
    this.#context = null;
    try {
      master?.disconnect();
    } catch {
      // A context already closed by the browser: nothing to disconnect.
    }
    try {
      context?.close();
    } catch {
      // Closing twice, or a context the browser already discarded.
    }
  }

  #open(): FeelAudioContext | null {
    if (this.#context) {
      // Chrome suspends an untouched context; the first cue follows a real gesture.
      if (this.#context.state === "suspended") {
        try {
          this.#context.resume();
        } catch {
          // A context that refuses to resume simply stays quiet.
        }
      }
      return this.#context;
    }
    let context: FeelAudioContext | null = null;
    try {
      context = this.#factory();
    } catch {
      // No audio on this device, or a policy refusing it: the page stays quiet.
      return null;
    }
    if (!context) return null;
    try {
      const master = context.createGain();
      master.gain.value = FEEL_MASTER_GAIN;
      master.connect(context.destination);
      this.#context = context;
      this.#master = master;
    } catch {
      try {
        context.close();
      } catch {
        // Nothing usable was built; drop it.
      }
      return null;
    }
    return this.#context;
  }

  #note(context: FeelAudioContext, master: FeelGainNode, voice: FeelVoice, phraseStart: number): void {
    const at = phraseStart + (voice.atMs ?? 0) / 1000;
    const duration = voice.durationMs / 1000;
    try {
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      oscillator.type = voice.wave;
      oscillator.frequency.setValueAtTime(voice.hz, at);
      if (voice.glide !== undefined) oscillator.frequency.exponentialRampToValueAtTime(voice.hz * voice.glide, at + duration);
      gain.gain.setValueAtTime(0, at);
      gain.gain.linearRampToValueAtTime(voice.gain, at + FEEL_ATTACK_MS / 1000);
      gain.gain.exponentialRampToValueAtTime(0.0001, at + duration);
      oscillator.connect(gain);
      gain.connect(master);
      oscillator.start(at);
      oscillator.stop(at + duration + FEEL_RELEASE_TAIL_MS / 1000);
    } catch {
      // Sound never breaks the action it followed.
    }
  }
}
