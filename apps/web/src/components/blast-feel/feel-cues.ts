/**
 * The Feel layer's sound cues and the one rule that decides which of them a
 * press answers with (`docs/product/social-feed/FEEL-LAYER.md` §1).
 *
 * Everything here is data and pure functions: no DOM, no audio, no React, so
 * the table and the press rule are testable without a browser. `feel-synth.ts`
 * turns a signal into sound; `feel-mount.ts` turns a DOM event into a signal.
 *
 * The original cues are the gate's (`design/blast-feel-preview.html`, sha256
 * `dd8cb26c…`), read from its `src/lab/feel.js` and confirmed in Chrome by
 * instrumenting `AudioContext.createOscillator`. A note's measured length is
 * its `durationMs` plus `FEEL_RELEASE_TAIL_MS`, because the oscillator is
 * stopped after the decay rather than at it.
 */

/** C5, the root of every phrase in the layer. */
const C5 = 523.25;

/** One note. `glide` bends the pitch to `hz * glide` over the note's length. */
export type FeelVoice = Readonly<{
  hz: number;
  wave: OscillatorType;
  gain: number;
  durationMs: number;
  glide?: number;
  /** Delay from the start of the phrase. */
  atMs?: number;
}>;

/**
 * What the layer can say. `tick` climbs with the charge level; `toggle` and
 * `follow` answer in two directions.
 */
export type FeelSignal =
  | Readonly<{ kind: "curve-buy" | "curve-sell" | "buy" | "sell" | "tap" | "navigate" | "notification" | "fire" | "land" | "claim" | "chord" | "error" | "open" | "close" | "expand" | "collapse" }>
  | Readonly<{ kind: "tick"; level: number }>
  | Readonly<{ kind: "toggle"; on: boolean }>
  | Readonly<{ kind: "follow"; on: boolean }>;

export type FeelSignalKind = FeelSignal["kind"];

/** The master gain every note runs through, into the destination. */
export const FEEL_MASTER_GAIN = 0.32;
/** Linear attack to the note's own gain. */
export const FEEL_ATTACK_MS = 6;
/** Kept playing this long after the decay, so the exponential tail is not clipped. */
export const FEEL_RELEASE_TAIL_MS = 30;
/** The pentatonic climb the charge ticks walk up; the level is clamped to the last step. */
export const FEEL_TICK_STEPS: readonly number[] = [1, 1.125, 1.25, 1.5, 1.6875, 2];

const ONE = (hz: number, gain: number, durationMs: number, wave: OscillatorType = "sine", glide?: number): readonly FeelVoice[] => [
  glide === undefined ? { hz, wave, gain, durationMs } : { hz, wave, gain, durationMs, glide },
];

const FIXED: Readonly<Record<Exclude<FeelSignalKind, "tick" | "toggle" | "follow">, readonly FeelVoice[]>> = {
  // Background ticks when the current market paints a new trade.
  "curve-buy": ONE(590, 0.065, 105, "sine", 1.32),
  "curve-sell": ONE(590, 0.065, 105, "sine", 0.72),
  // Confirmed buys climb; confirmed sells resolve down.
  buy: [
    { hz: 587.33, wave: "sine", gain: 0.22, durationMs: 140 },
    { hz: 880, wave: "sine", gain: 0.18, durationMs: 190, atMs: 65 },
  ],
  sell: [
    { hz: 783.99, wave: "sine", gain: 0.2, durationMs: 140 },
    { hz: 587.33, wave: "sine", gain: 0.18, durationMs: 175, atMs: 65 },
  ],
  // A soft glide when the new page arrives.
  navigate: ONE(330, 0.10, 135, "sine", 1.25),
  // A quiet bell for a newly delivered notification.
  notification: ONE(1046.5, 0.075, 225),
  // A press, on the way down, with the button's own scale.
  tap: ONE(880, 0.12, 45, "triangle"),
  // A held blast leaving the button.
  fire: ONE(260, 0.34, 200, "sine", 2.6),
  // Money arriving: a two-note landing.
  land: [
    { hz: 659.25, wave: "sine", gain: 0.3, durationMs: 240 },
    { hz: 987.77, wave: "sine", gain: 0.2, durationMs: 340, atMs: 45 },
  ],
  // A claim: three bright notes.
  claim: [
    { hz: C5, wave: "sine", gain: 0.24, durationMs: 260 },
    { hz: 659.25, wave: "sine", gain: 0.24, durationMs: 260, atMs: 60 },
    { hz: 783.99, wave: "sine", gain: 0.24, durationMs: 260, atMs: 120 },
  ],
  // A sale you are in funding: the chord resolves.
  chord: [
    { hz: C5, wave: "sine", gain: 0.18, durationMs: 700 },
    { hz: 659.25, wave: "sine", gain: 0.18, durationMs: 700, atMs: 80 },
    { hz: 783.99, wave: "sine", gain: 0.18, durationMs: 700, atMs: 160 },
    { hz: 1046.5, wave: "sine", gain: 0.18, durationMs: 700, atMs: 240 },
  ],
  // Two low notes.
  error: [
    { hz: 220, wave: "triangle", gain: 0.3, durationMs: 140 },
    { hz: 185, wave: "triangle", gain: 0.26, durationMs: 200, atMs: 90 },
  ],
  open: ONE(440, 0.12, 100, "sine", 1.4),
  close: ONE(560, 0.1, 100, "sine", 0.7),
  expand: ONE(392, 0.1, 80, "sine", 1.25),
  collapse: ONE(490, 0.09, 80, "sine", 0.8),
};

/** The notes one signal plays, in order. */
export function voicesFor(signal: FeelSignal): readonly FeelVoice[] {
  if (signal.kind === "tick") {
    const step = FEEL_TICK_STEPS[Math.min(Math.max(signal.level, 0), FEEL_TICK_STEPS.length - 1)] ?? 1;
    return [{ hz: C5 * step, wave: "triangle", gain: 0.26, durationMs: 80 }];
  }
  if (signal.kind === "toggle") return ONE(signal.on ? 740 : 494, 0.14, 60, "triangle");
  if (signal.kind === "follow") {
    const [first, second] = signal.on ? [659.25, 987.77] : [783.99, C5];
    return [
      { hz: first, wave: "sine", gain: 0.2, durationMs: 140 },
      { hz: second, wave: "sine", gain: 0.2, durationMs: 140, atMs: 70 },
    ];
  }
  return FIXED[signal.kind];
}

/**
 * Anything you can click or press answers with one soft tap. `[data-feel-press]`
 * is the product's own opt-in, for a card or row whose element is none of the
 * above.
 */
export const FEEL_PRESS_SELECTOR =
  'a[href], button, [data-act], [data-bx], [role="button"], [role="tab"], [role="option"], [role="menuitem"], [role="menuitemradio"], summary, .bx-card, [data-feel-press]';

/**
 * Except these, which have a sound of their own: a switch, anything that opens
 * or closes, follow. `[data-feel-follow]` is the product's follow control (an
 * account's Follow / Following, which carries `aria-pressed`); the gate's own
 * is `[data-act="follow"]`. `[data-feel-own]` opts a control out of the press
 * tap when it plays its own cue from its handler.
 */
export const FEEL_OWN_SELECTOR = '.switch, [role="switch"], [aria-expanded], [data-act="follow"], [data-feel-follow], [data-feel-own], [data-feel-sound]';

/** Fields never answer: typing is not pressing. */
export const FEEL_FIELD_SELECTOR = "input, textarea, select";

/** The tag names a key press is ignored on. */
const FIELD_TAGS = new Set(["INPUT", "TEXTAREA", "SELECT"]);

/**
 * The slice of `Element` this module needs. Declared structurally so the rule
 * is testable without a DOM; a real `Element` satisfies it.
 */
export type FeelNode = {
  readonly tagName: string;
  readonly disabled?: boolean;
  matches(selectors: string): boolean;
  closest(selectors: string): FeelNode | null;
  getAttribute(name: string): string | null;
};

/**
 * The pressable ancestor of `target`, or null when the press should stay
 * silent: nothing pressable, a disabled control, something with its own cue, or
 * a field.
 */
export function pressableFrom(target: FeelNode | null): FeelNode | null {
  if (!target) return null;
  const hit = target.closest(FEEL_PRESS_SELECTOR);
  if (!hit || hit.disabled === true) return null;
  if (hit.closest(FEEL_OWN_SELECTOR)) return null;
  if (hit.matches(FEEL_FIELD_SELECTOR)) return null;
  return hit;
}

/** A primary-button press answers on the way down; any other button is silent. */
export function pointerPressSignal(button: number, target: FeelNode | null): FeelSignal | null {
  if (button > 0) return null;
  return pressableFrom(target) ? { kind: "tap" } : null;
}

/** Enter or Space on a pressable thing, once (not while the key repeats), and never in a field. */
export function keyPressSignal(key: string, repeat: boolean, target: FeelNode | null): FeelSignal | null {
  if (repeat || (key !== "Enter" && key !== " ")) return null;
  if (target && FIELD_TAGS.has(target.tagName)) return null;
  return pressableFrom(target) ? { kind: "tap" } : null;
}

/**
 * The cue for a control that has one of its own, read from the DOM **before**
 * the page flips it: a switch ticks up for on and down for off, a follow
 * control rises or falls, and anything with `aria-expanded` glides open or
 * shut. The sound switch itself is skipped,
 * because turning it on is confirmed by `setSoundEnabled` instead.
 */
export function ownSignal(target: FeelNode | null): FeelSignal | null {
  if (!target) return null;
  const toggle = target.closest('.switch, [role="switch"]');
  if (toggle) {
    if (toggle.matches("[data-feel-sound]")) return null;
    return { kind: "toggle", on: toggle.getAttribute("aria-checked") !== "true" };
  }
  // Follow rises to follow and falls to unfollow, by the state it is about to take.
  const follow = target.closest("[data-feel-follow]");
  if (follow) {
    if (follow.disabled === true) return null;
    return { kind: "follow", on: follow.getAttribute("aria-pressed") !== "true" };
  }
  const expandable = target.closest("[aria-expanded]");
  if (!expandable || expandable.disabled === true) return null;
  return expandable.getAttribute("aria-expanded") === "true" ? { kind: "collapse" } : { kind: "expand" };
}
