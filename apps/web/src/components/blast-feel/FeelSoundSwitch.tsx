"use client";

import clsx from "clsx";

import { FEEL_SOUND_BUTTON_CLASS } from "./feel-ball.ts";
import { useFeelSound } from "./FeelProvider.tsx";

/**
 * The layer's one control (FEEL-LAYER.md §1, R3-12).
 *
 * Two shapes, one state, as the gate draws them: a switch in Settings' "Feel"
 * section, and an icon button in the Blast mode header. Both read and write the
 * same `blast.sound`, so they are always in step.
 *
 * **Off until the reader turns it on** — here or in the other shape — signed
 * in or not (`feel-sound-pref.ts`). Turning it on confirms itself with one
 * soft tap. A signed-in surface passes `onToggle` so the choice is also kept
 * on the account (`social/settings/use-sound-switch.ts`); without it the
 * choice stays on this device.
 *
 * Accessibility: the switch carries `role="switch"` with `aria-checked`; the
 * icon button carries `aria-pressed` and an `aria-label`, because it has no
 * text. Both are ordinary focusable buttons — nothing is captured, no focus
 * moves, and `data-feel-sound` keeps the layer's own click rule from giving
 * them a second cue on top of their own.
 */

const SPEAKER_ON = (
  <>
    <path d="M5 9.5h3.2L12.5 6v12l-4.3-3.5H5z" />
    <path d="M15.5 9.2a4 4 0 0 1 0 5.6M18 7a7 7 0 0 1 0 10" />
  </>
);

const SPEAKER_OFF = (
  <>
    <path d="M5 9.5h3.2L12.5 6v12l-4.3-3.5H5z" />
    <path d="m16 10 4 4M20 10l-4 4" />
  </>
);

function Speaker({ on }: Readonly<{ on: boolean }>) {
  return (
    <svg aria-hidden="true" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.6" viewBox="0 0 24 24">
      {on ? SPEAKER_ON : SPEAKER_OFF}
    </svg>
  );
}

export type FeelSoundControlProps = Readonly<{
  className?: string;
  /** Who keeps the choice besides this device (a signed-in account); the layer's own setter when absent. */
  onToggle?: (on: boolean) => void;
}>;

/** The Settings row's control: `role="switch"`, in the shell's own switch style. */
export function FeelSoundSwitch({ className = "switch", onToggle }: FeelSoundControlProps) {
  const { soundEnabled, setSoundEnabled } = useFeelSound();
  const toggle = onToggle ?? setSoundEnabled;
  return (
    <button
      aria-checked={soundEnabled}
      aria-label="Sound"
      className={className}
      data-feel-sound=""
      onClick={() => toggle(!soundEnabled)}
      role="switch"
      type="button"
    />
  );
}

/** The Blast mode header's control: an icon button, 34px with a mouse and 44px under a finger. */
export function FeelSoundButton({ className = "icon-btn", onToggle }: FeelSoundControlProps) {
  const { soundEnabled, setSoundEnabled } = useFeelSound();
  const toggle = onToggle ?? setSoundEnabled;
  return (
    <button
      aria-label="Sound"
      aria-pressed={soundEnabled}
      className={clsx(className, FEEL_SOUND_BUTTON_CLASS)}
      data-feel-sound=""
      data-tip={soundEnabled ? "Sound on" : "Sound off"}
      onClick={() => toggle(!soundEnabled)}
      type="button"
    >
      <Speaker on={soundEnabled} />
    </button>
  );
}

/** The gate's wording for Settings' "Feel" section, so a caller does not re-invent it. */
export const FEEL_SETTINGS_SECTION_TITLE = "Feel";
export const FEEL_SETTINGS_ROW_TITLE = "Sound";
export const FEEL_SETTINGS_ROW_DESCRIPTION = "Hear price moves, live buys and sells, taps and confirmations.";
