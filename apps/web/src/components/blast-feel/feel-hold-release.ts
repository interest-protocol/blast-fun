/**
 * What a charged release does, in order (R3-13), with every effect injected so
 * the order is a test:
 *
 * 1. **the quote**, before anything flies. A refusal plays `error`, shakes the
 *    ball where it stands (not under reduced motion), and hands its own words
 *    to `refused`. Nothing is sent.
 * 2. **the flight**: `fire`, then the ball arcs into the sale's bar and the
 *    bar flashes. With no bar on screen, or under reduced motion, there is no
 *    ball and the commit goes at once — with the same sounds.
 * 3. **the commit**. The ball landing is not the success signal: the commit's
 *    own answer is, and the commit reports it (the host plays `land` or
 *    `error`, toasts, and the bar's figures move only when a route says so).
 *    A commit that throws is a failure nobody reported: `error`, and the
 *    generic sentence.
 */

import type { FeelSignal } from "./feel-cues.ts";
import type { FeelPoint } from "./feel-hold.ts";

/** The words for a commit that failed without saying why. */
export const FEEL_HOLD_FAILED = "That didn’t go through. Nothing was sent.";

export type HeldReleaseDeps = Readonly<{
  amountUsd: number;
  play: (signal: FeelSignal) => void;
  /** Reduced motion says no: then no ball is created at all. */
  motion: boolean;
  quote: (amountUsd: number) => string | null | Promise<string | null>;
  /** Where the ball lands, or null when no bar is on screen. */
  landing: () => FeelPoint | null;
  shake: () => Promise<void>;
  fly: (landing: FeelPoint) => Promise<void>;
  flash: () => void;
  commit: (amountUsd: number) => Promise<void>;
  refused: (message: string) => void;
}>;

export type HeldReleaseOutcome = "refused" | "committed" | "failed";

export async function runHeldRelease(deps: HeldReleaseDeps): Promise<HeldReleaseOutcome> {
  let refusal: string | null;
  try {
    refusal = (await deps.quote(deps.amountUsd)) ?? null;
  } catch {
    refusal = FEEL_HOLD_FAILED;
  }
  if (refusal !== null) {
    deps.play({ kind: "error" });
    if (deps.motion) await deps.shake();
    deps.refused(refusal);
    return "refused";
  }
  deps.play({ kind: "fire" });
  const landing = deps.motion ? deps.landing() : null;
  if (landing !== null) {
    await deps.fly(landing);
    deps.flash();
  }
  try {
    await deps.commit(deps.amountUsd);
    return "committed";
  } catch {
    deps.play({ kind: "error" });
    deps.refused(FEEL_HOLD_FAILED);
    return "failed";
  }
}
