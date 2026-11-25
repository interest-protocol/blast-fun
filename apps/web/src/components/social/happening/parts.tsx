"use client";

import { hoverExcerpt } from "#web/lib/hover-text.ts";
import clsx from "clsx";
import { IntentLink as Link } from "#web/components/blast-ui/NavigationLink.tsx";
import { useCallback, useLayoutEffect, useRef, type MouseEvent, type ReactNode } from "react";

import { BellIcon } from "#web/components/blast-ui/Icons.tsx";
import { useShellActions } from "#web/components/blast-ui/shell-actions.tsx";
import { useToast } from "#web/components/blast-ui/Toasts.tsx";
import { TWEEN_NUM_S } from "#web/components/blast-ui/tween-num.ts";
import { TweenNum } from "#web/components/blast-ui/use-tween-num.tsx";
import type { SocialHappeningResponse } from "@blast/core/web/contracts/happening.ts";
import type { FeedItemPresale } from "@blast/core/web/contracts/items.ts";

import { slideBarFill } from "../blast-mode/live/bar-slide";
import { useFeedOverlays } from "../feed-ui/shell-bridge";
import { presaleHref } from "../feed-ui/shell-bridge-model";
import { Avatar } from "../post/PostMedia";
import { useSignInGate } from "../SignInGate";
import { useViewerBackers, useViewerFollow, useViewerStateStore } from "../ViewerState";
import { followErrorMessage } from "../viewer-state-client";
import styles from "./Happening.module.css";
import { backedTitle, liveLine } from "./happening-model";

/** The prototype's pin (`I.pin`), 24px line icon. */
export function PinIcon() {
  return (
    <svg aria-hidden="true" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" viewBox="0 0 24 24">
      <path d="M12 17v5" />
      <path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z" />
    </svg>
  );
}

/**
 * "**312 people** committed **$48.2K** to presales in the last hour", both
 * figures counting to each new read as the gate's do (`tweenNum(…, .8)`: whole
 * people, `short()` dollars, on every frame).
 */
export function LiveLine({ lastHour }: Readonly<{ lastHour: SocialHappeningResponse["last_hour"] }>) {
  return (
    <p className={styles.liveLine}>
      <strong>
        <TweenNum duration={TWEEN_NUM_S.lastHour} format={(wallets) => liveLine({ wallets: Math.round(wallets), usd: lastHour.usd }).people} value={lastHour.wallets} />
      </strong> committed
      {lastHour.usd_complete === false && Number(lastHour.usd) === 0 ? null : (
        <> {lastHour.usd_complete === false ? "at least " : ""}<strong>
          <TweenNum duration={TWEEN_NUM_S.lastHour} format={(usd) => liveLine({ wallets: lastHour.wallets, usd: String(usd) }).usd} value={Number(lastHour.usd)} />
        </strong></>
      )} to presales in the last hour.
      {lastHour.usd_complete === false ? " Some USD values are unavailable." : null}
    </p>
  );
}

/**
 * A presale link that opens the sale dialog when one is mounted (§11), else
 * goes to the presale page.
 */
export function SaleLink({ presaleId, className, children, label }: Readonly<{ presaleId: string; className?: string; children: ReactNode; label?: string }>) {
  const overlays = useFeedOverlays();
  return (
    <Link
      aria-haspopup={overlays.mounted.sale ? "dialog" : undefined}
      aria-label={label}
      className={className}
      href={presaleHref(presaleId)}
      onClick={(event) => {
        if (!overlays.mounted.sale || event.metaKey || event.ctrlKey || event.shiftKey) return;
        event.preventDefault();
        overlays.openSale(presaleId);
      }}

    >
      {children}
    </Link>
  );
}

/**
 * Up to three of the viewer's followed backers of a presale (avatars 18, a
 * `title` naming them), from viewer-state; nothing for a visitor or when none.
 * `withCount` adds "3 you follow" (the recap).
 */
export function FollowedPile({ presaleId, withCount = false }: Readonly<{ presaleId: string; withCount?: boolean }>) {
  const backers = useViewerBackers(presaleId);
  if (!backers || backers.count === 0) return null;
  const faces = backers.accounts.slice(0, 3);
  const pile = (
    <span className={styles.pile} title={withCount ? undefined : hoverExcerpt(backedTitle(faces.map((face) => face.display_name ?? face.callsign)))}>
      {faces.map((face) => (
        <Avatar callsign={face.callsign} key={face.callsign} size={26} src={face.avatar_url} />
      ))}
    </span>
  );
  if (!withCount) return pile;
  return (
    <span className={styles.rpile}>
      {pile}
      {backers.count.toLocaleString("en-US")} you follow
    </span>
  );
}

/**
 * Following a pending presale (§5.3: the bell and "Notify me" are the same
 * state): toggled through viewer-state with failure feedback; a visitor
 * gets the sign-in sheet.
 */
export function usePresaleNotify(presale: Pick<FeedItemPresale, "presale_id" | "name">) {
  const store = useViewerStateStore();
  const following = useViewerFollow({ kind: "presale", presale_id: presale.presale_id }) === true;
  const toast = useToast();
  const gate = useSignInGate();
  const run = useShellActions();
  const toggle = useCallback(async () => {
    if (!gate.signedIn || !store) {
      if (!run("openSignIn")) window.location.assign(gate.signInHref);
      return;
    }
    // Shown at once; a refusal puts the bell back.
    const result = await store.setFollowing({ kind: "presale", presale_id: presale.presale_id }, !following);
    if (result.status !== "ok") toast(followErrorMessage(result, !following));
  }, [gate.signedIn, gate.signInHref, store, run, presale.presale_id, following, toast]);
  return { following, toggle };
}

/** The bell of an "Opening soon" row (36, round). */
export function NotifyBell({ presale }: Readonly<{ presale: Pick<FeedItemPresale, "presale_id" | "name"> }>) {
  const { following, toggle } = usePresaleNotify(presale);
  return (
    <button
      aria-label={`${following ? "Notifications on" : "Notify me"} for ${presale.name}`}
      aria-pressed={following}
      className={clsx("icon-btn", styles.notify)}
      onClick={(event: MouseEvent) => {
        event.preventDefault();
        void toggle();
      }}
      title={following ? "You’ll be notified" : "Notify me"}
      type="button"
    >
      <BellIcon />
    </button>
  );
}

/**
 * A progress fill whose scale is set through the DOM (the page's CSP allows
 * no inline style attribute), growing in on first paint as the design's bars
 * do; later reads slide it to the new scale. `bar` names the sale whose raise
 * it draws (`data-bar`, the gate's own attribute): a held blast's ball lands
 * in it (R3-13, `feelBarFor`).
 */
export function Fill({ pct, bar }: Readonly<{ pct: number; bar?: string }>) {
  const ref = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    if (ref.current) slideBarFill(ref.current, pct);
  }, [pct]);
  return <i data-bar={bar} data-grow="" ref={ref} />;
}
