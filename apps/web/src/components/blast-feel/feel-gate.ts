/**
 * The Feel layer's rules for **when** a cue may sound, in front of the synth
 * (R3-12's "product rules the gate does not state").
 *
 * The gate's lab plays whatever it is asked to, whenever. The product adds four
 * rules, and this is the one place they live, as pure bookkeeping over an
 * injected clock, so each is provable without a browser:
 *
 *  1. **Nothing before the first gesture.** Until the reader has pressed or
 *     typed on the page, every cue is refused, so no `AudioContext` is ever
 *     constructed before a gesture — not even by a money result or a
 *     celebration that arrives first.
 *  2. **Nothing while the document is hidden.** A background tab is silent.
 *  3. **A press is one voice per 60 ms.** A fast scroll of presses, or a
 *     finger dragged over a list, cannot stack taps into noise: twenty presses
 *     in 200 ms are four taps.
 *  4. **One money sound per event.** `buy`, `sell`, `land`, `claim`, `chord` and `error`
 *     answer the result of a real write; two paths reporting the same result
 *     (a dialog closing and its commit landing, a hold and its host) sound it
 *     once.
 *
 * And one rule a caller opts into: a **fresh** cue (`open`/`close` from a
 * sheet) sounds only within a second of a gesture, so a sheet that opens on
 * its own — the celebration, from a live read — is silent rather than a live
 * update the reader did not cause.
 */

import type { FeelSignal, FeelSignalKind } from "./feel-cues.ts";

/** At most one press tap in this window. */
export const FEEL_TAP_MIN_GAP_MS = 60;
/** The same money sound twice inside this window is one event, sounded once. */
export const FEEL_MONEY_EVENT_MS = 300;
/** A fresh cue needs a gesture this recent. */
export const FEEL_FRESH_GESTURE_MS = 1000;

/** The sounds that follow money rather than a press. */
export const FEEL_MONEY_KINDS: ReadonlySet<FeelSignalKind> = new Set<FeelSignalKind>(["buy", "sell", "land", "claim", "chord", "error"]);

export type FeelPlayOptions = Readonly<{
  /**
   * Only sound if a gesture happened within `FEEL_FRESH_GESTURE_MS`: for a cue
   * a component plays on its own state change (a sheet opening), which may or
   * may not be the reader's doing.
   */
  fresh?: boolean;
}>;

const TRADE_MIN_GAP_MS = 1_200;
const isCurveTrade = (signal: FeelSignal) => signal.kind === "curve-buy" || signal.kind === "curve-sell";

export type FeelRefusal = "trade-rate" | "no-gesture" | "hidden" | "tap-rate" | "money-event" | "stale";

export class FeelGate {
  readonly #now: () => number;
  readonly #visible: () => boolean;
  #lastGesture: number | null = null;
  #lastTrade = Number.NEGATIVE_INFINITY;
  #lastTap = Number.NEGATIVE_INFINITY;
  readonly #lastMoney = new Map<FeelSignalKind, number>();

  constructor(now: () => number, visible: () => boolean = () => true) {
    this.#now = now;
    this.#visible = visible;
  }

  /** Whether the reader has pressed or typed on the page yet. */
  get gestured(): boolean {
    return this.#lastGesture !== null;
  }

  /** A real gesture: a primary-button press or a key, seen in the capture phase before the page's own handler. */
  gesture(): void {
    this.#lastGesture = this.#now();
  }

  /** Why `signal` may not sound now, or null when it may. Does not record anything. */
  refusal(signal: FeelSignal, options: FeelPlayOptions = {}): FeelRefusal | null {
    if (this.#lastGesture === null) return "no-gesture";
    if (!this.#visible()) return "hidden";
    const now = this.#now();
    if (options.fresh === true && now - this.#lastGesture > FEEL_FRESH_GESTURE_MS) return "stale";
    if (isCurveTrade(signal) && now - this.#lastTrade < TRADE_MIN_GAP_MS) return "trade-rate";
    if (signal.kind === "tap" && now - this.#lastTap < FEEL_TAP_MIN_GAP_MS) return "tap-rate";
    if (FEEL_MONEY_KINDS.has(signal.kind)) {
      const last = this.#lastMoney.get(signal.kind);
      if (last !== undefined && now - last < FEEL_MONEY_EVENT_MS) return "money-event";
    }
    return null;
  }

  /**
   * Asks to sound `signal`: true when it may, and then it counts against the
   * caps. A refused cue is simply dropped — it is never queued for later.
   */
  admit(signal: FeelSignal, options: FeelPlayOptions = {}): boolean {
    if (this.refusal(signal, options) !== null) return false;
    const now = this.#now();
    if (isCurveTrade(signal)) this.#lastTrade = now;
    if (signal.kind === "tap") this.#lastTap = now;
    if (FEEL_MONEY_KINDS.has(signal.kind)) this.#lastMoney.set(signal.kind, now);
    return true;
  }
}

/** The browser's visibility, read at the moment of the cue. True where there is no document (a test). */
export function documentVisible(): boolean {
  return typeof document === "undefined" || document.visibilityState !== "hidden";
}

/** The slice of the synth the gate stands in front of. */
export type FeelVoiceSink = Readonly<{ enabled: boolean; play: (signal: FeelSignal) => void }>;

/**
 * One cue through the gate. A cue the synth would not sound anyway (sound off)
 * never counts against the gate's caps, and a refused one never reaches the
 * synth — so no audio context is built for it.
 */
export function gatedPlay(synth: FeelVoiceSink, gate: FeelGate, signal: FeelSignal, options?: FeelPlayOptions): void {
  if (!synth.enabled) return;
  if (!gate.admit(signal, options)) return;
  synth.play(signal);
}
