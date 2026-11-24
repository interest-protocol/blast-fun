"use client";

import clsx from "clsx";
import { useState } from "react";

import { useToast } from "#web/components/blast-ui/Toasts.tsx";
import { useSocialViewer } from "../SignInGate";
import { followErrorMessage } from "../viewer-state-client";
import { useViewerFollow, useViewerStateStore } from "../ViewerState";
import styles from "./PostFollow.module.css";

/**
 * Follow in a post (FEATURE-MAP §3.3): shown to a signed-in viewer for a
 * named author they do not follow, never on their own posts and never to a
 * visitor. It appears once the viewer state says "not following" (no flash
 * for an author already followed), and after a tap it stays in place as
 * "Following" (hover: "Unfollow"), so the card does not jump. Writes go
 * through the follow routes; the label changes once the route accepts; a
 * toast explains a failed action.
 */
export function PostFollow({ callsign }: Readonly<{ callsign: string }>) {
  const viewer = useSocialViewer();
  const store = useViewerStateStore();
  const following = useViewerFollow({ kind: "account", callsign });
  const toast = useToast();
  const [shown, setShown] = useState(false);
  const [busy, setBusy] = useState(false);
  // Derived while rendering: the button appears the first time the viewer is known not to follow.
  if (!shown && following === false) setShown(true);
  if (!viewer.signedIn || !store || !shown || viewer.callsign === callsign) return null;

  const on = following === true;
  async function toggle() {
    if (busy || !store) return;
    const next = !on;
    setBusy(true);
    const result = await store.setFollowing({ kind: "account", callsign }, next).catch(() => ({ status: "error" as const })).finally(() => setBusy(false));
    if (result.status !== "ok") toast(followErrorMessage(result, next));
  }

  return (
    <button
      aria-busy={busy || undefined}
      aria-label={on ? `Following @${callsign}. Unfollow` : `Follow @${callsign}`}
      aria-pressed={on}
      className={clsx(styles.follow, on && styles.on)}
      data-feel-follow=""
      onClick={toggle}
      type="button"
    >
      <span aria-hidden="true" className={styles.lOff}>Follow</span>
      <span aria-hidden="true" className={styles.lOn}>Following</span>
      <span aria-hidden="true" className={styles.lHover}>Unfollow</span>
    </button>
  );
}
