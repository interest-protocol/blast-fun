"use client";

import clsx from "clsx";
import { IntentLink as Link } from "#web/components/blast-ui/NavigationLink.tsx";
import { useState } from "react";

import { useFeedOverlays } from "../feed-ui/shell-bridge";
import { RocketIcon } from "../feed-ui/icons";
import { useToast } from "#web/components/blast-ui/Toasts.tsx";
import { reactionErrorMessage } from "../viewer-state-client";
import { useViewerReactions, useViewerReactionsAtRead, useViewerStateStore } from "../ViewerState";
import styles from "./RocketButton.module.css";
import { rocketCount, rocketLabel } from "./post-model";

/** The one reaction (OA-5). */
export const ROCKET = "rocket";

const countText = (count: number) => (count > 0 ? count.toLocaleString("en-US") : "");

type Roll = Readonly<{ shown: number; previous: string | null; up: boolean; key: number }>;

/**
 * The rocket toggle (FEATURE-MAP §3.2). A signed-in viewer's tap shows at once
 * (pressed, the count rolls, the icon launches) and writes through
 * `PUT`/`DELETE /api/social/items/{entry_id}/reactions/rocket`; a refusal puts
 * the count and the button back and says why in a toast. A visitor's tap
 * opens sign-in (the sign-in page until the shell's sheet exists).
 */
export function RocketButton({ entryId, count }: Readonly<{ entryId: string; count: number }>) {
  const overlays = useFeedOverlays();
  const store = useViewerStateStore();
  const mine = useViewerReactions(entryId);
  const atRead = useViewerReactionsAtRead(entryId);
  const toast = useToast();
  const pressed = mine?.includes(ROCKET) ?? false;
  const mineAtRead = atRead?.includes(ROCKET) ?? false;
  const shown = rocketCount(count, mineAtRead, mine === undefined ? mineAtRead : pressed);

  // The roll is derived from the shown count: a change starts one (state set while rendering, React's pattern).
  const [roll, setRoll] = useState<Roll>({ shown, previous: null, up: true, key: 0 });
  if (roll.shown !== shown) setRoll({ shown, previous: countText(roll.shown), up: shown > roll.shown, key: roll.key + 1 });
  const [launching, setLaunching] = useState(false);

  const label = rocketLabel(shown);
  const className = clsx(styles.rocket, shown === 0 && styles.iconOnly, launching && styles.launch);
  const number = (
    <span aria-hidden="true" className={styles.roll}>
      {roll.previous !== null ? (
        <span
          key={`out-${roll.key}`}
          className={clsx(styles.leaving, roll.up ? styles.outUp : styles.outDown)}
          onAnimationEnd={() => setRoll((current) => (current.key === roll.key ? { ...current, previous: null } : current))}
        >
          {roll.previous}
        </span>
      ) : null}
      <span key={`in-${roll.key}`} className={roll.previous !== null ? (roll.up ? styles.inUp : styles.inDown) : undefined}>
        {countText(shown)}
      </span>
    </span>
  );

  if (!overlays.signedIn) {
    // A visitor's tap opens sign-in: the shell's sheet when it is registered, else this link's page.
    return (
      <Link
        className={className}
        href={overlays.signInHref}

        aria-label={`${label}. Sign in to react`}
        data-gated="sign-in"
        onClick={(event) => {
          if (overlays.openSignIn()) event.preventDefault();
        }}
      >
        <RocketIcon />
        {number}
      </Link>
    );
  }

  async function toggle() {
    if (!store) return;
    const next = !pressed;
    if (next) setLaunching(true);
    const result = await store.setReaction(entryId, ROCKET, next);
    if (result.status !== "ok") toast(reactionErrorMessage(result));
  }

  return (
    <button
      aria-label={label}
      aria-pressed={pressed}
      className={className}
      onAnimationEnd={(event) => {
        if (event.animationName.includes("launch")) setLaunching(false);
      }}
      onClick={toggle}
      type="button"
    >
      <RocketIcon />
      {number}
    </button>
  );
}
