/**
 * The Feel layer's page-wide listeners, and the only place they are installed
 * (FEEL-LAYER.md §1).
 *
 * The press cue is a property of the whole page, not of a component: on Home
 * alone it answers 134 elements — every link, button, row, tab and card. Asking
 * each of them to opt in would be both impossible to finish and impossible to
 * keep finished, so this is one delegated listener per event, in the capture
 * phase, exactly as the gate does it. Three listeners replace 134 opt-ins.
 *
 * Every one of them goes through the caller's `FeelScope`, so `FeelProvider`'s
 * effect cleanup is a single `scope.stop()` and `feelActive()` can prove there
 * is nothing left. Nothing here reads or writes the DOM beyond asking the event
 * target what it is, so none of it runs on the server.
 */

import { keyPressSignal, ownSignal, pointerPressSignal, type FeelNode, type FeelSignal } from "./feel-cues.ts";
import { FeelGate, gatedPlay, type FeelPlayOptions } from "./feel-gate.ts";
import type { FeelEventTarget, FeelScope } from "./feel-scope.ts";
import { followSoundEnabled } from "./feel-sound-pref.ts";
import { FeelSynth, type FeelAudioContextFactory } from "./feel-synth.ts";

/** The slice of a pointer event the press rule needs. */
export type FeelPointerish = Readonly<{ button: number; target: unknown }>;
/** The slice of a keyboard event the press rule needs. */
export type FeelKeyish = Readonly<{ key: string; repeat: boolean; target: unknown }>;
/** The slice of a click event the own-cue rule needs. */
export type FeelClickish = Readonly<{ target: unknown }>;

/** Whether an event target can answer the press rule's questions. */
export function isFeelNode(value: unknown): value is FeelNode {
  if (typeof value !== "object" || value === null) return false;
  const node = value as Partial<FeelNode>;
  return typeof node.tagName === "string" && typeof node.matches === "function" && typeof node.closest === "function" && typeof node.getAttribute === "function";
}

export type FeelMountHost = Readonly<{
  /** Where the delegated listeners go: `document` in the app. */
  target: FeelEventTarget;
  scope: FeelScope;
  play: (signal: FeelSignal) => void;
  /**
   * A real gesture happened (a press or a key), reported before the cue it
   * may produce, so the first press of a session can already be heard. The
   * layer refuses every cue until the first one (`feel-gate.ts`).
   */
  gesture?: () => void;
}>;

/**
 * Installs the three delegated cue listeners. Returns nothing to undo: the
 * caller's `scope.stop()` is the undo, so there is exactly one teardown path.
 */
export function mountFeelCues(host: FeelMountHost): void {
  const { scope, play } = host;

  // A press answers on the way down, with the button's own scale.
  scope.on<FeelPointerish>(host.target, "pointerdown", (event) => {
    host.gesture?.();
    if (!isFeelNode(event.target)) return;
    const signal = pointerPressSignal(event.button, event.target);
    if (signal) play(signal);
  });

  // The keyboard reaches the same things. Nothing is prevented and nothing is
  // stopped, so no key is ever swallowed: this only listens.
  scope.on<FeelKeyish>(host.target, "keydown", (event) => {
    host.gesture?.();
    if (!isFeelNode(event.target)) return;
    const signal = keyPressSignal(event.key, event.repeat, event.target);
    if (signal) play(signal);
  });

  // Switches and anything that opens or closes have a cue of their own, read
  // before the page flips the attribute.
  scope.on<FeelClickish>(host.target, "click", (event) => {
    if (!isFeelNode(event.target)) return;
    const signal = ownSignal(event.target);
    if (signal) play(signal);
  });
}

export type FeelAudioHost = Readonly<{
  /** Where the delegated listeners go: `document` in the app. */
  target: FeelEventTarget;
  scope: FeelScope;
  /** Makes the one audio context, only ever called from a cue that may sound. */
  audioContext: FeelAudioContextFactory;
  now: () => number;
  visible: () => boolean;
}>;

export type FeelAudio = Readonly<{
  /** One cue through the gate: silent while sound is off, before a gesture, while hidden, or over a cap. */
  play: (signal: FeelSignal, options?: FeelPlayOptions) => void;
  /** Stops following the flag and closes the audio context. The listeners go with the host's scope. */
  dispose: () => void;
}>;

/**
 * The provider's whole audio path, mounted once: one synth, which follows the
 * sound flag synchronously (`followSoundEnabled`), one gate in front of it,
 * and the delegated cue listeners. Every cue on the page — the listeners',
 * and every `play` a surface makes through the provider — goes through
 * `gatedPlay`, which drops it while the synth is off; the synth builds or
 * resumes an audio context only from a cue it plays. So while the flag is off
 * nothing sounds and no audio context is created or resumed.
 */
export function startFeelAudio(host: FeelAudioHost): FeelAudio {
  const synth = new FeelSynth(host.audioContext);
  const unfollow = followSoundEnabled((enabled) => synth.setEnabled(enabled));
  const gate = new FeelGate(host.now, host.visible);
  mountFeelCues({
    target: host.target,
    scope: host.scope,
    gesture: () => gate.gesture(),
    play: (signal) => gatedPlay(synth, gate, signal),
  });
  return {
    play: (signal, options) => gatedPlay(synth, gate, signal, options),
    dispose: () => {
      unfollow();
      synth.dispose();
    },
  };
}
