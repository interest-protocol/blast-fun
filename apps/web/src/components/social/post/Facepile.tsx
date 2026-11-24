"use client";

import { IntentLink as Link } from "#web/components/blast-ui/NavigationLink.tsx";

import type { FeedItemBacker } from "@blast/core/web/contracts/items.ts";

import { useSocialViewer } from "../SignInGate";
import { useViewerBackers } from "../ViewerState";
import { facepile } from "./post-model";
import { decimal, usd } from "./post-format";
import styles from "./PostCard.module.css";
import { Avatar } from "./PostMedia";

/** "Ana" (a first name), or "You" for the viewer. */
function faceName(backer: FeedItemBacker, viewerCallsign: string | null): string {
  if (backer.callsign === viewerCallsign) return "You";
  return (backer.display_name ?? backer.callsign).split(" ")[0] ?? backer.callsign;
}

/**
 * A presale post's facepile (FEATURE-MAP §3.5): up to six named backers, the
 * ones the viewer follows first, each linking to its profile with a tooltip
 * ("Ana" / "@anasouza · $1,200 in") on hover and focus; then "7 people you
 * follow and 1,005 others are in" (without follows: "1,012 others are in").
 */
export function Facepile({
  presaleId,
  list,
  participants,
}: Readonly<{ presaleId: string; list: readonly FeedItemBacker[]; participants: number }>) {
  const viewer = useSocialViewer();
  const followed = useViewerBackers(presaleId);
  const { faces, followed: followedCount, others } = facepile({ list, participants }, followed ?? null);
  if (faces.length === 0) return null;
  return (
    <div className={styles.pileRow}>
      <span className={styles.pile}>
        {faces.map((backer) => {
          const name = faceName(backer, viewer.callsign);
          const amount = decimal(backer.usd);
          const inLine = amount === null ? "in" : `${usd(Math.round(amount))} in`;
          return (
            <Link aria-label={`${name}, ${inLine}`} className={styles.face} href={backer.path} key={backer.callsign}>
              <Avatar callsign={backer.callsign} size={30} src={backer.avatar_url} />
              <span aria-hidden="true" className={styles.tip} role="tooltip">
                <b>{name}</b>
                <span>@{backer.callsign} · {inLine}</span>
              </span>
            </Link>
          );
        })}
      </span>
      <span className={styles.pileTxt}>
        {followedCount > 0 ? (
          <>
            <b>{followedCount.toLocaleString("en-US")} {followedCount === 1 ? "person" : "people"} you follow</b> and{" "}
          </>
        ) : null}
        <span className={styles.num}>{others.toLocaleString("en-US")}</span> others are in
      </span>
    </div>
  );
}
