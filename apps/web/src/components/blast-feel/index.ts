/**
 * The Feel layer: the interaction layer OA-23 added to the acceptance gate.
 *
 * What it is, measured against the gate byte for byte, is written up in
 * `docs/product/social-feed/FEEL-LAYER.md`. In short: short, quiet sounds
 * generated in the browser for anything you press, open, close, switch, follow,
 * claim, commit or get an error from; and hold-to-blast on every Blast button,
 * where the button charges $50 → $100 → $500 → $1,000 and a small pink ball
 * arcs into the sale's bar when you let go.
 *
 * How to use it:
 *
 *  - The app shell mounts `<FeelProvider>` once (`src/app/(app)/layout.tsx`).
 *    That alone gives every surface the press, switch and expand cues; nothing
 *    else has to opt in.
 *  - A surface that completes an action plays its cue:
 *    `useFeelSound().play({ kind: "land" })`.
 *  - A Blast button opts into the charge with `useFeelHold(...)` and spreads
 *    `holdProps`; a social surface does it through
 *    `social/commit/use-held-blast.ts`, which commits through the one commit
 *    module (R3-13).
 *  - Settings renders `<FeelSoundSwitch />`; the Blast mode header renders
 *    `<FeelSoundButton />`.
 *
 * Three rules the layer keeps, and the tests that hold it to them:
 *
 *  - `prefers-reduced-motion: reduce` **switches the animation off**, not down:
 *    no ball is created, no keyframes run, the glow has no transition.
 *  - Sound is **off until the reader turns it on** (the owner, amending OA-25
 *    Q3a), signed in or not; the choice is kept per device and, when signed
 *    in, on the account. No audio context exists until sound is on and a cue
 *    follows the reader's first gesture, nothing sounds while the tab is
 *    hidden, a press is one voice per 60 ms and a money result sounds once
 *    (`feel-gate.ts`).
 *  - Every timer, frame, listener and stray node belongs to a `FeelScope`;
 *    `feelActive()` reads zero after an unmount, and `feel-mount.test.ts`
 *    proves it.
 */

export { FeelProvider, useFeel, useFeelMotion, useFeelSound, type FeelContextValue } from "./FeelProvider.tsx";
export {
  FEEL_SETTINGS_ROW_DESCRIPTION,
  FEEL_SETTINGS_ROW_TITLE,
  FEEL_SETTINGS_SECTION_TITLE,
  FeelSoundButton,
  FeelSoundSwitch,
  type FeelSoundControlProps,
} from "./FeelSoundSwitch.tsx";
export { holdAriaLabel, holdLabel, useFeelHold, type FeelHold, type FeelHoldOptions, type FeelHoldProps } from "./use-feel-hold.ts";
export {
  FeelHoldGesture,
  holdScopeOnTasks,
  type HoldGestureHost,
  type HoldOutcome,
  type HoldPress,
  type HoldRelease,
  type HoldScope,
  type HoldTimers,
} from "./feel-hold-gesture.ts";
export { feelBarFor, flashBar } from "./feel-ball.ts";
export { useFeelOpenClose } from "./use-feel-open-close.ts";
export {
  FEEL_HOLD_AMOUNTS_USD,
  FEEL_HOLD_ARM_MS,
  FEEL_HOLD_CANCEL_PX,
  FEEL_HOLD_STEP_MS,
  holdAmountUsd,
} from "./feel-hold.ts";
export { feelActive, FeelScope, type FeelActivity } from "./feel-scope.ts";
export {
  adoptAccountSound,
  FEEL_SOUND_DEFAULT,
  FEEL_SOUND_KEY,
  markSoundSaved,
  motionAllowed,
  soundChangeMark,
  useReducedMotion,
  useSoundEnabled,
} from "./feel-sound-pref.ts";
export { FEEL_FRESH_GESTURE_MS, FEEL_MONEY_EVENT_MS, FEEL_TAP_MIN_GAP_MS, type FeelPlayOptions } from "./feel-gate.ts";
export type { FeelSignal, FeelVoice } from "./feel-cues.ts";
