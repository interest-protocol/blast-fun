"use client";

import { Collapse } from "#web/components/blast-ui/Collapse.tsx";

import clsx from "clsx";
import { useId, useState, type ReactNode } from "react";

import { PageHeader } from "#web/components/blast-ui/PageHeader.tsx";
import type { ProfilePresale, SocialProfileCalls, SocialProfileMutuals } from "@blast/core/web/contracts/profile-page.ts";
import type { SocialProfile } from "@blast/core/web/contracts/profiles.ts";
import type { SocialPnl } from "@blast/core/web/contracts/pnl.ts";

import { LockIcon } from "./icons";
import { IdentityCard } from "./IdentityCard";
import { GoldCard } from "./PortfolioCards";
import styles from "./Profile.module.css";
import { ProfileTabs } from "./ProfileTabs";
import { PnlBreakdown, PnlTile } from "./PnlBreakdown";
import type { PortfolioTrendView } from "./portfolio-trend";
import type { GoldFigures } from "./profile-model";
import type { Loadable } from "./use-profile-data";

export type ProfileScreenProfile = Omit<SocialProfile, "as_of">;

export type ProfileScreenData = Readonly<{
  /** The viewer owns this profile (browser only). */
  own: boolean;
  calls: Loadable<SocialProfileCalls>;
  /** Reads the calls again after a failure. */
  retryCalls?: () => void;
  created?: Loadable<readonly ProfilePresale[]>;
  retryCreated?: () => void;
  mutuals: Loadable<SocialProfileMutuals>;
  /** Another account's public portfolio (the gold card's figures); `none` on one's own profile. */
  gold: Loadable<GoldFigures>;
  /** The gold card's 30-day line; null until the account has a month of daily snapshots (OA-25 Q16). */
  trend?: PortfolioTrendView | null;
  pnl?: Loadable<SocialPnl>;
  retryPnl?: () => void;
  hidden?: boolean;
}>;

/**
 * The profile page's layout (§6): the header (own: "Profile"; others: the
 * back bar, "‹ Home"), the identity card, then a private account's note, or
 * another account's public gold card (OA-10) and the sections. One's own
 * profile is who you are and your calls: its gold card and holdings are on
 * Portfolio (R3-74, R3-76). Presentational: the data comes from
 * `ProfileView` (or a fixture).
 */
export function ProfileScreen({
  profile,
  data,
  nowMs,
  onEdit,
  sheet,
  loading = false,
}: Readonly<{ profile: ProfileScreenProfile; data: ProfileScreenData; nowMs: number; onEdit: () => void; sheet?: ReactNode; loading?: boolean }>) {
  const { own, hidden = false, pnl = { status: "none" }, trend = null } = data;
  const [pnlOpen, setPnlOpen] = useState(false);
  const pnlId = useId();
  const pnlAllowed = own || (!profile.private && profile.portfolio_public);
  const ownerCallsign = own ? profile.callsign : undefined;
  const showPnl = pnlOpen && pnlAllowed;
  const record = data.calls.status === "ready" ? data.calls.value.track_record : null;
  // oa41 `viewProfile`: `showPf = !own && a.openPortfolio`.
  const showPortfolio = !own && profile.portfolio_public;
  const name = profile.display_name ?? profile.callsign;
  const pageLabel = loading
    ? { "aria-busy": true, "aria-label": "Loading profile", "data-route-loading": "profile", inert: true }
    : { "aria-labelledby": "profile-name" };
  return (
    <>
      {loading ? <span className="sr" role="status">Loading profile</span> : null}
      <article {...pageLabel} className={styles.page}>
        <ProfileHeader />
        <IdentityCard loading={loading} mutuals={data.mutuals} onEdit={onEdit} own={own} profile={profile} record={record} recordLoading={["none", "loading"].includes(data.calls.status)}
          pnl={<PnlTile allowed={pnlAllowed} controls={pnlId} expanded={pnlOpen} hidden={hidden} onToggle={() => setPnlOpen(!pnlOpen)} pnl={pnl} />} />
        {profile.private && !own ? (
          <div className={clsx("card", styles.privateNote)}>
            <span className={styles.ico}>
              <LockIcon />
            </span>
            <b>This account is private</b>
            <span>Their actions don&apos;t appear on Blast.</span>
          </div>
        ) : (
          <>
            <Collapse id={pnlId} keepMounted={false} open={showPnl}>
              <div className={styles.sec}><PnlBreakdown hidden={hidden} ownerCallsign={ownerCallsign} pnl={pnl} retry={data.retryPnl} /></div>
            </Collapse>
            {showPortfolio ? (
              <div className={styles.sec}>
                <GoldCard gold={data.gold} name={name} trend={trend} />
              </div>
            ) : null}
            <ProfileTabs loading={loading} callsign={profile.callsign} calls={data.calls} created={data.created} nowMs={nowMs} onRetryCalls={data.retryCalls} onRetryCreated={data.retryCreated} own={own} />
          </>
        )}
        {sheet}
      </article>
    </>
  );
}

function ProfileHeader() {
  // KA-2: the rail already leads home; the title stands alone (2026-11-14).
  return <PageHeader title="Profile" />;
}
