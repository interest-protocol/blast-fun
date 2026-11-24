"use client";

import clsx from "clsx";
import { useId, type ReactNode } from "react";
import { actorKey, type ActorIdentity, type AvatarSize } from "./actor-identity";

import { InspectValue } from "#web/components/blast-ui/InspectValue.tsx";
import { IntentLink } from "#web/components/blast-ui/NavigationLink.tsx";
import { VerifiedBadge } from "#web/components/blast-ui/Icons.tsx";
import { AccountAvatar } from "#web/components/social/AccountAvatar.tsx";
import { useViewerFollow } from "#web/components/social/ViewerState.tsx";
import { walletHue } from "#web/components/social/post/post-format.ts";

import styles from "./ActorCell.module.css";

/** The profile picture Blast shows everywhere: the account's photo, its card ring, or the same generated gradient. */
export function ActorAvatar({ identity, size }: Readonly<{ identity: ActorIdentity; size: AvatarSize }>) {
  const id = useId();
  if (identity.kind === "account")
    return (
      <span aria-hidden="true" className={styles.avatar} data-size={size}>
        <AccountAvatar accountId={identity.callsign} avatarUrl={identity.avatarUrl} size={size} />
      </span>
    );
  const hue = walletHue(identity.short);
  return (
    <span aria-hidden="true" className={styles.avatar} data-size={size}>
      <svg height={size} preserveAspectRatio="none" viewBox="0 0 1 1" width={size}>
        <defs>
          <linearGradient id={id} x1="0.047" x2="0.953" y1="-0.04" y2="1.04">
            <stop offset="0" stopColor={`hsl(${hue} 70% 66%)`} />
            <stop offset="1" stopColor={`hsl(${(hue + 52) % 360} 64% 50%)`} />
          </linearGradient>
        </defs>
        <rect fill={`url(#${id})`} height="1" width="1" />
      </svg>
    </span>
  );
}

function FollowingTag({ callsign }: Readonly<{ callsign: string }>) {
  const following = useViewerFollow({ kind: "account", callsign });
  return following === true ? <span className={styles.following} title="Following">
    <svg className={styles.followingIcon} aria-hidden="true" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="m3 8 3 3 7-7" /></svg>
    <span className={styles.followingText}>Following</span>
  </span> : null;
}

/**
 * Avatar, name and verification for one row. The name opens the person's
 * Blast profile (leaving Blast mode, which B restores as it was); a second
 * line appears only when the row has something to say.
 * A wallet keeps its short address visible and opens the full address in the
 * shared inspector; it is never given an invented name.
 */
export function ActorCell({
  identity,
  size = 28,
  detail,
  className,
  showFollowing = true,
  compact = false,
}: Readonly<{ identity: ActorIdentity; size?: AvatarSize; detail?: ReactNode; className?: string; showFollowing?: boolean; compact?: boolean }>) {
  return (
    <span className={clsx(styles.cell, compact && styles.compact, className)}>
      <ActorAvatar identity={identity} size={size} />
      <span className={styles.text}>
        {identity.kind === "account" ? (
          <>
            <span className={styles.nameLine}>
              <IntentLink className={styles.name} href={`/@${identity.callsign}`} title={`View @${identity.callsign}`}>
                {identity.name}
              </IntentLink>
              {identity.verified ? <VerifiedBadge className={styles.verified} /> : null}
              {showFollowing && <FollowingTag callsign={identity.callsign} />}
            </span>
            {detail ? <span className={styles.detail}>{detail}</span> : null}
          </>
        ) : (
          <>
            <span className={styles.nameLine}>
              <InspectValue label="wallet address" value={identity.address}>
                <span className={clsx(styles.name, "mono")}>{identity.short}</span>
              </InspectValue>
            </span>
            {detail ? <span className={styles.detail}>{detail}</span> : null}
          </>
        )}
      </span>
    </span>
  );
}

/** A few overlapping avatars for a count beside them; the count is the information, the faces are recognition. */
export function Facepile({
  identities,
  size = 22,
  max = 4,
}: Readonly<{ identities: readonly ActorIdentity[]; size?: 22 | 24 | 28; max?: number }>) {
  if (identities.length === 0) return null;
  return (
    <span aria-hidden="true" className={styles.pile} data-size={size}>
      {identities.slice(0, max).map((identity) => (
        <ActorAvatar identity={identity} key={actorKey(identity)} size={size} />
      ))}
    </span>
  );
}
