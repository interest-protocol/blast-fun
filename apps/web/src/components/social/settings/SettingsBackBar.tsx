"use client";

import Link from "next/link";
import type { MouseEvent } from "react";

import { profilePath } from "#web/components/blast-ui/nav.ts";

import { useHydrated } from "../profile/use-profile-data";
import { useSignInGate, useSocialViewer } from "../SignInGate";
import { PreviousIcon } from "#web/components/blast-ui/Icons.tsx";
import { backLabelOf } from "./settings-model";
import styles from "./SettingsView.module.css";

/** The page to go back to, and how many history entries back it is. */
type Previous = Readonly<{ label: string; href: string; steps: number }>;

/**
 * The page before this one in the tab's history, when it is a page the bar can
 * name (`backLabelOf`). Read from the Navigation API, which keeps the app's
 * client-side moves as entries; Settings' own entries (a sheet's query) are
 * skipped. Null without the API, on a direct load, or for a page it cannot name.
 */
function previousPage(ownCallsign: string | null): Previous | null {
  if (!("navigation" in window)) return null;
  const nav = window.navigation;
  const current = nav.currentEntry;
  if (!current || current.index < 1) return null;
  const entries = nav.entries();
  const here = window.location.pathname;
  for (let index = current.index - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (!entry?.url) return null;
    const url = new URL(entry.url);
    if (url.origin !== window.location.origin) return null;
    if (url.pathname === here) continue;
    const label = backLabelOf(url.pathname, ownCallsign);
    return label === null ? null : { label, href: `${url.pathname}${url.search}`, steps: current.index - index };
  }
  return null;
}

/** The board's back link: 28px, 13/600, a 16px chevron, 10px over the title (`data-back-bar` drops the title's top space). */
function BackLink({ href, label, onClick }: Readonly<{ href: string; label: string; onClick?: (event: MouseEvent<HTMLAnchorElement>) => void }>) {
  return (
    <div className={styles.backbar} data-back-bar="">
      <Link className={styles.back} href={href} onClick={onClick}>
        <PreviousIcon />
        {label}
      </Link>
    </div>
  );
}

/**
 * Settings' back link (oa41: `backbar('#u-<me>', 'Profile')` before the
 * title): "‹ <the page you came from>", which steps back to it — `Portfolio`
 * when you came from Portfolio — and "‹ Profile" (one's own profile) on a
 * direct load or after a page it cannot name. It sits above the title, which
 * keeps the page head for the right column's alignment.
 */
export function SettingsBackBarView({ ownCallsign, profileHref }: Readonly<{ ownCallsign: string | null; profileHref: string }>) {
  const hydrated = useHydrated();
  const previous = hydrated ? previousPage(ownCallsign) : null;
  if (!previous) return <BackLink href={profileHref} label="Profile" />;
  const back = (event: MouseEvent<HTMLAnchorElement>) => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
    event.preventDefault();
    window.history.go(-previous.steps);
  };
  return <BackLink href={previous.href} label={previous.label} onClick={back} />;
}

/** The page's back bar, for the signed-in viewer (a visitor's "Profile" is sign-in, as the shell's is). */
export function SettingsBackBar() {
  const viewer = useSocialViewer();
  const gate = useSignInGate();
  const hydrated = useHydrated();
  const callsign = hydrated && viewer.signedIn ? viewer.callsign : null;
  return <SettingsBackBarView ownCallsign={callsign} profileHref={callsign ? profilePath(callsign) : gate.signInHref} />;
}
