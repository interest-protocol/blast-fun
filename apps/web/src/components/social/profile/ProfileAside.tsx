"use client";

import clsx from "clsx";
import { IntentLink as Link } from "#web/components/blast-ui/NavigationLink.tsx";
import { CoinVerifiedMark } from "#web/components/blast-ui/Icons.tsx";

import { presalePath } from "@blast/core/modules/social/items/do-the-same.ts";
import type { SocialMePresales, SocialProfileCalls } from "@blast/core/web/contracts/profile-page.ts";

import { ProfileInvitesCard } from "./ProfileInvites";
import { ProfileRailLoading } from "./ProfileRailLoading";
import { WatchlistCard } from "../watchlist/WatchlistCard";
import { rowOfProfilePresale } from "../watchlist/watchlist-model";
import styles from "./Profile.module.css";
import { PresaleMark, StatusChip } from "./parts";
import { backedTogether, inRightNowOf, ownInRightNow, type SideRow } from "./profile-model";
import { useAmountsHidden, useProfileOwnership, useMePresales, useProfileCalls } from "./use-profile-data";

function Row({ row }: Readonly<{ row: SideRow }>) {
  return (
    <Link className={styles.lrow} href={presalePath(row.presale.presale_id)}>
      <PresaleMark presale={row.presale} />
      <span className={styles.t}>
        {row.presale.verified_team ? <span className={styles.named}><b>{row.presale.name}</b><CoinVerifiedMark size="sm" /></span> : <b>{row.presale.name}</b>}
        <span>{row.sub}</span>
      </span>
      {row.right ? (
        <span className={styles.v}>
          <b className={row.right.tone ? styles[row.right.tone] : undefined}>{row.right.inner ? <span>{row.right.top}</span> : row.right.top}</b>
          {row.right.bottom ? <span className={styles.muted}>{row.right.bottom}</span> : null}
        </span>
      ) : row.status ? (
        <StatusChip status={row.status} />
      ) : null}
    </Link>
  );
}

function Card({ title, count, rows }: Readonly<{ title: string; count?: number; rows: readonly SideRow[] }>) {
  if (rows.length === 0) return null;
  return (
    <div className={clsx("card", styles.listCard)} data-aside-card="">
      <h3 className={styles.lcH}>
        <span>{title}</span>
        {count !== undefined ? <span className={styles.num}>{count}</span> : null}
      </h3>
      {rows.map((row) => (
        <Row key={row.presale.presale_id} row={row} />
      ))}
    </div>
  );
}

/** One's own "In right now" (open positions): the own profile's and the Portfolio page's right column. */
export function OwnInRightNowCard({ me, hidden, nowMs }: Readonly<{ me: SocialMePresales | null; hidden: boolean; nowMs: number }>) {
  return <Card rows={me ? ownInRightNow(me.positions, nowMs, hidden) : []} title="In right now" />;
}

/**
 * The profile's right column (the Profile board; the shell's column sets the
 * cards 16px apart), presentational:
 * one's own Invites (with the callsign), "In right now" and "Watchlist", or
 * someone else's "In right now" (their open calls) and "Backed together" (the
 * viewer's positions in presales they called).
 */
export function ProfileAsideCards({
  own,
  callsign,
  firstName,
  calls,
  me,
  hidden,
  nowMs,
}: Readonly<{ own: boolean; callsign?: string; firstName: string; calls: SocialProfileCalls | null; me: SocialMePresales | null; hidden: boolean; nowMs: number }>) {
  if (own) {
    return (
      <>
        {callsign ? <ProfileInvitesCard callsign={callsign} /> : null}
        <OwnInRightNowCard hidden={hidden} me={me} nowMs={nowMs} />
        {me ? <WatchlistCard nowMs={nowMs} rows={me.watchlist.map(rowOfProfilePresale)} /> : null}
      </>
    );
  }
  const together = me && calls ? backedTogether(firstName, me.positions, calls.calls, hidden) : [];
  return (
    <>
      <Card rows={calls ? inRightNowOf(calls.calls, nowMs) : []} title="In right now" />
      <Card count={together.length} rows={together} title="Backed together" />
    </>
  );
}

/** The right column of `/@<callsign>`: the `@rail` slot's page renders it with the server's calls. */
export function ProfileAside({
  callsign,
  firstName,
  initialCalls,
  nowMs,
}: Readonly<{ callsign: string; firstName: string; initialCalls: SocialProfileCalls | null; nowMs: number }>) {
  const { own, pending } = useProfileOwnership(callsign);
  const calls = useProfileCalls(callsign, initialCalls);
  const me = useMePresales(true, true);
  const hidden = useAmountsHidden();
  if (pending || (own && me.status === "loading")) return <ProfileRailLoading />;
  return (
    <ProfileAsideCards
      callsign={callsign}
      calls={calls.status === "ready" ? calls.value : null}
      firstName={firstName}
      hidden={hidden}
      me={me.status === "ready" ? me.value : null}
      nowMs={nowMs}
      own={own}
    />
  );
}
