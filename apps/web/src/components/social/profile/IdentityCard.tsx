"use client";

import { Button, IconButton } from "#web/components/blast-ui/Button.tsx";
import clsx from "clsx";
import Link from "next/link";
import { useState, type MouseEvent, type ReactNode } from "react";

import { PencilIcon, VerifiedBadge, XLogo } from "#web/components/blast-ui/Icons.tsx";
import { SkeletonBox, SkeletonText } from "#web/components/blast-ui/Skeleton.tsx";
import type { ProfileTrackRecord, SocialProfileMutuals } from "@blast/core/web/contracts/profile-page.ts";
import type { SocialProfile } from "@blast/core/web/contracts/profiles.ts";

import { useSignInGate } from "../SignInGate";
import { followErrorMessage } from "../viewer-state-client";
import { useViewerFollow, useViewerFollowReadFailed, useViewerStateStore } from "../ViewerState";
import styles from "./Profile.module.css";
import { Avatar } from "./parts";
import { mutualsLine, trackTiles } from "./profile-model";
import type { Loadable } from "./use-profile-data";
import { ProfileCrewCard } from "./ProfileCrewCard";
import { ProfileConnectionCounts } from "./ProfileConnectionCounts";

export type IdentityProfile = Pick<SocialProfile, "callsign" | "display_name" | "bio" | "avatar_url" | "x_handle" | "verified" | "private">;

function isUnverifiedAnsem(profile: IdentityProfile): boolean {
  return profile.callsign === "ansem" && (!profile.verified || profile.x_handle?.toLowerCase() !== "blknoiz06");
}

function followActionLabel(callsign: string, following: boolean, undo: boolean) {
  if (undo) return `Undo unfollow @${callsign}`;
  return following ? `Following @${callsign}. Unfollow` : `Follow @${callsign}`;
}

function FollowReadStatus({ callsign, failed, onRetry }: Readonly<{ callsign: string; failed: boolean; onRetry?: () => void }>) {
  return <Button
    aria-label={failed ? `Relationship unavailable. Retry status for @${callsign}` : `Checking follow status for @${callsign}`}
    aria-busy={!failed || undefined}
    className={styles.follow}
    disabled={!failed}
    onClick={onRetry}
    variant="ink"
  >{failed ? "Retry status" : <SkeletonText>Following</SkeletonText>}</Button>;
}

/** Follow's markup for a state (§3.3, 40 high), without the viewer wiring. */
export function ProfileFollowView({
  callsign,
  signInHref,
  onSignIn,
  following,
  error = null,
  onToggle,
  undo = false,
  readFailed = false,
  onRetryRead,
}: Readonly<{
  callsign: string;
  /** A visitor's sign-in link (the control is then that link), or null for a signed-in viewer. */
  signInHref: string | null;
  onSignIn?: (event: MouseEvent) => void;
  following: boolean | undefined;
  error?: string | null;
  onToggle?: () => void;
  undo?: boolean;
  readFailed?: boolean;
  onRetryRead?: () => void;
}>) {
  if (signInHref !== null) {
    return (
      <Link className={clsx("btn btn-ink", styles.follow)} data-gated="sign-in" href={signInHref} onClick={onSignIn} prefetch={false}>
        Follow<span className="sr"> @{callsign}</span>
      </Link>
    );
  }
  if (following === undefined) return <FollowReadStatus callsign={callsign} failed={readFailed} onRetry={onRetryRead} />;
  const on = following;
  return (
    <div>
      <button
        aria-label={followActionLabel(callsign, on, undo)}
        aria-pressed={on}
        className={clsx("btn btn-ink", styles.follow)}
        data-feel-follow=""
        data-state={on ? "following" : "not-following"}
        onClick={onToggle}
        type="button"
      >
        {undo ? "Undo" : on ? (
          <>
            <span className={styles.lOn}>Following</span>
            <span className={styles.lHover}>Unfollow</span>
          </>
        ) : (
          "Follow"
        )}
        <span className="sr"> @{callsign}</span>
      </button>
      {error ? (
        <p className={styles.followError} role="alert">
          {error} <button className={styles.followRetry} aria-label={`Retry follow action for @${callsign}`} onClick={onToggle} type="button">Retry</button>
        </p>
      ) : null}
    </div>
  );
}

/**
 * Follow on a profile: "Follow" (ink), then "Following" (line), which reads
 * "Unfollow" on hover. A visitor's opens the sign-in sheet. The label
 * changes once the follow route accepts; a refusal says why.
 */
export function ProfileFollow({ callsign, undo = false, followingHint }: Readonly<{ callsign: string; undo?: boolean; followingHint?: boolean }>) {
  const gate = useSignInGate();
  const store = useViewerStateStore();
  const following = useViewerFollow({ kind: "account", callsign }) ?? followingHint;
  const readFailed = useViewerFollowReadFailed({ kind: "account", callsign });
  const [error, setError] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState("");
  async function toggle() {
    if (following === undefined || gate.sessionPending || !store) return;
    // Shown at once; a refusal puts the button back and says why.
    const next = undo || following !== true;
    setError(null);
    setAnnouncement("");
    try {
      const result = await store.setFollowing({ kind: "account", callsign }, next);
      if (result.status !== "ok") setError(followErrorMessage(result, next));
      else setAnnouncement(next ? `Now following @${callsign}` : `Unfollowed @${callsign}`);
    } catch {
      setError(followErrorMessage({ status: "error" }, next));
    }
  }
  return (
    <><span role="status" className="sr">{announcement}</span><ProfileFollowView
      undo={undo}
      callsign={callsign}
      error={error}
      following={gate.sessionPending ? undefined : following}
      readFailed={readFailed}
      onRetryRead={() => store?.want({ callsigns: [callsign] })}
      onSignIn={gate.openSignIn}
      onToggle={toggle}
      signInHref={gate.signedIn || gate.sessionPending ? null : gate.signInHref}
    /></>
  );
}

/**
 * The identity card (the Profile board): the 88px avatar beside the name with
 * its verified mark (OA-8: X linked) and the actions (own: "Edit profile",
 * which opens the edit sheet, OA-14; Invites and Settings live in the account
 * menu only; others: Follow), the handle row with the X chip and, on one's own profile, the
 * sharing status, the follower counts and "Followed by …"; then the crew card
 * row and the track record tiles (not for a private account).
 */
export function IdentityCard({
  profile,
  own,
  mutuals,
  record,
  recordLoading,
  onEdit,
  pnl,
  loading = false,
}: Readonly<{
  profile: IdentityProfile;
  own: boolean;
  mutuals: Loadable<SocialProfileMutuals>;
  /** The track record; null while it loads or when it could not be read. */
  record: ProfileTrackRecord | null;
  recordLoading: boolean;
  onEdit: () => void;
  pnl: ReactNode;
  loading?: boolean;
}>) {
  const line = mutuals.status === "ready" ? mutualsLine(mutuals.value) : null;
  const unverified = isUnverifiedAnsem(profile);
  return (
    <section aria-labelledby="profile-name" className={clsx("card", styles.prof)}>
      <div className={styles.profTop}>
        {loading ? <span aria-hidden="true" className={styles.loadingAvatar} /> : <Avatar seed={profile.callsign} size={89} url={profile.avatar_url} />}
        <ProfileName loading={loading} profile={profile} unverified={unverified} />
        <ProfileActions callsign={profile.callsign} loading={loading} onEdit={onEdit} own={own} />
        <ProfileHandle loading={loading} own={own} profile={profile} unverified={unverified} />
        <ProfileConnectionCounts className={styles.profCounts} loading={loading} profile={profile} own={own} />
        {line && mutuals.status === "ready" ? (
          <div className={styles.mutuals}>
            <span className={styles.miniPile}>
              {mutuals.value.accounts.map((account) => (
                <Avatar key={account.callsign} seed={account.callsign} size={18} url={account.avatar_url} />
              ))}
            </span>
            {line}
          </div>
        ) : null}
      </div>
      {!loading && profile.bio ? <p className={styles.bio} dir="auto">{profile.bio}</p> : null}
      <ProfileCrewCard callsign={profile.callsign} key={profile.callsign} loading={loading} own={own} />
      {profile.private && !own ? null : (
        <div className={styles.tiles} aria-busy={recordLoading || undefined}>
          {/* An unread record omits its tiles rather than showing a dash. */}
          {(record || recordLoading ? trackTiles(record) : []).map((tile) => (
            <div key={tile.label}>
              <span>{tile.label}</span>
              <b className={tile.tone ?? undefined}>{recordLoading ? <SkeletonText>Figure</SkeletonText> : tile.value}</b>
            </div>
          ))}
          {pnl}
        </div>
      )}
    </section>
  );
}

function ProfileActions({ callsign, own, loading, onEdit }: Readonly<{
  callsign: string; own: boolean; loading: boolean; onEdit: () => void;
}>) {
  if (!own) {
    return <div className={styles.profFollow}>{loading ? <span aria-hidden="true" className={clsx("btn btn-line", styles.follow)}><SkeletonText>Follow</SkeletonText></span> : <ProfileFollow callsign={callsign} />}</div>;
  }
  return (
    <div className={styles.profActs}>
      {loading ? <SkeletonBox className={styles.editSkeleton} /> : (
        <IconButton aria-haspopup="dialog" aria-label="Edit profile" onClick={onEdit} size="touch" title="Edit profile" variant="secondary">
          <PencilIcon />
        </IconButton>
      )}
    </div>
  );
}

function ProfileName({ loading, profile, unverified }: Readonly<{ loading: boolean; profile: IdentityProfile; unverified: boolean }>) {
  const name = profile.display_name ?? profile.callsign;
  return (
    <h2 id="profile-name">
      <span>{loading ? <SkeletonText>{name || "Display name"}</SkeletonText> : name}</span>
      {profile.verified && !unverified ? <VerifiedBadge className="verified" /> : null}
    </h2>
  );
}

function ProfileHandle({ loading, own, profile, unverified }: Readonly<{ loading: boolean; own: boolean; profile: IdentityProfile; unverified: boolean }>) {
  return (
    <div className={styles.handle}>
      <span>{loading ? <SkeletonText>@{profile.callsign || "callsign"}</SkeletonText> : `@${profile.callsign}`}</span>
      {!loading && unverified ? <span className="status" data-tone="pending">Unverified</span> : null}
      {profile.x_handle ? (
        <a className={styles.xchip} href={`https://x.com/${encodeURIComponent(profile.x_handle)}`} rel="noopener noreferrer" target="_blank">
          <XLogo />
          {profile.x_handle}
          <span className="sr"> on X (opens in a new tab)</span>
        </a>
      ) : null}
      {own ? (
        // The app-wide chip (R3-04), not a module class: see `StatusChip`.
        <span className="status" data-tone={profile.private ? "cancelled" : "trading"}>
          {loading ? <SkeletonText>Sharing activity</SkeletonText> : profile.private ? "Private account" : "Sharing activity"}
        </span>
      ) : null}
    </div>
  );
}
