"use client";
import { PendingPanel } from "#web/components/blast-ui/PendingPanel.tsx";

import { useAppendedRowsReveal, type LoadMoreRows } from "#web/components/blast-ui/use-appended-rows-reveal.ts";
import { Button, ButtonLink } from "#web/components/blast-ui/Button.tsx";
import { EmptyState } from "#web/components/blast-ui/EmptyState.tsx";
import { diagnosticMessage } from "#web/lib/errors.ts";

import { ago } from "@blast/core/web/format.ts";
import clsx from "clsx";
import { IntentLink as Link } from "#web/components/blast-ui/NavigationLink.tsx";
import { useId, useState, type ReactNode } from "react";

import { ChevronIcon } from "#web/components/blast-ui/Icons.tsx";
import { PageHeader } from "#web/components/blast-ui/PageHeader.tsx";
import { ShellAvatar } from "#web/components/blast-ui/ShellAvatar.tsx";
import { CoinArtwork } from "#web/components/blast-ui/CoinArtwork.tsx";
import type { SocialNotification } from "@blast/core/web/contracts/notifications.ts";

import styles from "./NotificationsView.module.css";

/**
 * The Notifications page (canonical UI §13) as the Notifications board draws
 * it: the header, one list card of `a.alert` rows (the mark or avatar with the kind's status
 * badge, title, one-line sub, time, unread dot) under "Today" and "Earlier",
 * and "Show older". The states the board does not draw (OA-13): loading,
 * empty, error, signed out and setting up.
 */

export type NotificationsMode = "list" | "loading" | "empty" | "error" | "visitor" | "no-account";


/** The board's badge glyphs: 11px, a 3px stroke in the ground colour. */
const BADGE_PATHS = {
  check: "m5 12.5 4.5 4.5L19 7.5",
  down: "M12 5v14M6 13l6 6 6-6",
  clock: "M12 7v5l3 2",
  up: "M7 17 17 7M9 7h8v8",
} as const;

type BadgeTone = "ink" | "pink" | "info" | "warn" | "up";

/**
 * Each kind's status badge, as the Notifications board draws it: claims are
 * an ink arrow down, a filling sale and its last hour a pink clock, funded an
 * info check, a sale opening soon (and an unlock) a warn clock, a followed
 * account an ink check, and a called coin's rise an up arrow on the price-up
 * colour.
 */
function kindBadge(notification: Pick<SocialNotification, "kind" | "title">): Readonly<{ glyph: keyof typeof BADGE_PATHS; tone: BadgeTone }> {
  switch (notification.kind) {
    case "claim":
      return { glyph: "down", tone: "ink" };
    case "fill":
      return { glyph: "clock", tone: "pink" };
    case "funded":
      return { glyph: "check", tone: "info" };
    case "follow":
      return { glyph: "check", tone: "ink" };
    case "soon":
      return { glyph: "clock", tone: /^Last hour\b/.test(notification.title) ? "pink" : "warn" };
    case "call_up":
      return { glyph: "up", tone: "up" };
    default:
      return { glyph: "clock", tone: "warn" };
  }
}

function Badge({ notification }: Readonly<{ notification: SocialNotification }>) {
  const { glyph, tone } = kindBadge(notification);
  return (
    <em className={styles.badge} data-tone={tone}>
      <svg aria-hidden="true" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="3" viewBox="0 0 24 24">
        <path d={BADGE_PATHS[glyph]} />
      </svg>
    </em>
  );
}

function SaleMark({ notification }: Readonly<{ notification: SocialNotification }>) {
  return <span aria-hidden="true" className={styles.mark}><CoinArtwork coinType={notification.presale?.coin_type} fallbackId={notification.presale?.presale_id ?? notification.id} src={notification.presale?.icon_url ?? null} size={40} /></span>;
}

function NotificationSubtitle({ notification }: Readonly<{ notification: SocialNotification }>) {
  const [logoFailed, setLogoFailed] = useState(false);
  const venue = "Bluefin";
  const destination = `on ${venue}`;
  if (notification.kind !== "funded" || !/\btrading opens on Bluefin$/i.test(notification.sub) || logoFailed) return notification.sub;

  return (
    <>
      {notification.sub.slice(0, -destination.length)}
      <span className={styles.venue} title={venue}>
        {notification.sub.slice(-destination.length, -venue.length)}
        {/* Use the existing local venue mark; its name remains in the link's accessible text. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img alt={venue} className={styles.venueLogo} draggable={false} height={16} onError={() => setLogoFailed(true)} src="/blast-ui/dex/bluefin.svg" width={16} />
      </span>
    </>
  );
}

function Row({ notification, nowMs }: Readonly<{ notification: SocialNotification; nowMs: number }>) {
  const unread = !notification.read;
  return (
    <Link
      className={styles.alert}
      data-row-id={notification.id}
      data-unread={unread ? "" : undefined}
      data-claim={notification.kind === "claim" ? "" : undefined}
      href={notification.href}
    >
      <span className={styles.ico}>
        {notification.actor ? (
          <ShellAvatar size={40} viewer={{ accountId: notification.actor.callsign, avatarUrl: notification.actor.avatar_url }} />
        ) : (
          <SaleMark notification={notification} />
        )}
        <Badge notification={notification} />
      </span>
      <span className={styles.t}>
        <b>
          {unread ? <span className="sr">Unread: </span> : null}
          {notification.title}
        </b>
        <span><NotificationSubtitle notification={notification} /></span>
      </span>
      <time className={styles.when} dateTime={new Date(notification.occurred_at_ms).toISOString()}>
        {ago(notification.occurred_at_ms, nowMs)}
      </time>
      <span aria-hidden="true" className={styles.dot} />
    </Link>
  );
}

/** Loading (OA-13): rows hold their place. */
function SkeletonRows() {
  return <PendingPanel framed label="Loading notifications" />;
}

/** Today's rows and the earlier ones, by the viewer's calendar day; an empty group is left out. */
function notificationGroups(items: readonly SocialNotification[], nowMs: number) {
  const today = new Date(nowMs);
  today.setHours(0, 0, 0, 0);
  const start = today.getTime();
  return [
    { label: "Today", items: items.filter((item) => item.occurred_at_ms >= start) },
    { label: "Earlier", items: items.filter((item) => item.occurred_at_ms < start) },
  ].filter((group) => group.items.length > 0);
}

function NotificationGroup({ label, children }: Readonly<{ label: string; children: ReactNode }>) {
  const id = useId();
  return (
    <section aria-labelledby={id} className={styles.group}>
      <h2 className={styles.groupLabel} id={id}>{label}</h2>
      {children}
    </section>
  );
}

export type NotificationsViewProps = Readonly<{
  mode: NotificationsMode;
  errorMessage?: string;
  items: readonly SocialNotification[];
  nowMs: number;
  vestingClaimCount?: number;
  /** A next page exists. */
  hasMore?: boolean;
  loadingMore?: boolean;
  onMore?: LoadMoreRows;
  onRetry?: () => void;
  /** The sign-in control for a visitor (opens the sign-in sheet). */
  signIn?: ReactNode;
}>;

function NotificationList({ items, mode, nowMs, vestingClaimCount = 0 }: Pick<NotificationsViewProps, "items" | "mode" | "nowMs" | "vestingClaimCount">) {
  const hasVestingReminder = vestingClaimCount > 0;
  if (mode !== "list" && !hasVestingReminder) return null;
  const groups = mode === "list" ? notificationGroups(items, nowMs) : [];
  return (
    <div className={clsx("card", styles.list)}>
      {hasVestingReminder ? (
        <Link className={clsx(styles.alert, styles.vestingReminder)} href="/portfolio?tab=vestings">
          <span className={styles.t}><b>{vestingClaimCount} vesting {vestingClaimCount === 1 ? "claim" : "claims"} ready</b></span>
          <ChevronIcon />
        </Link>
      ) : null}
      {groups.map((group) => (
        <NotificationGroup key={group.label} label={group.label}>
          {group.items.map((notification) => (
            <Row key={notification.id} notification={notification} nowMs={nowMs} />
          ))}
        </NotificationGroup>
      ))}
    </div>
  );
}

export function NotificationsView(props: NotificationsViewProps) {
  const { mode, items, nowMs, vestingClaimCount = 0 } = props;
  const { listRef, more, requested } = useAppendedRowsReveal(items.map(item => item.id), props.onMore);
  return (
    // `data-shell-aside="medium"`: the board's Watchlist column (300px plus its 8px insets).
    <div ref={listRef} className={styles.page} data-shell-aside="medium">
      <PageHeader title="Notifications" />
      <NotificationList items={items} mode={mode} nowMs={nowMs} vestingClaimCount={vestingClaimCount} />
      {mode === "loading" ? <SkeletonRows /> : null}
      {mode === "list" && (props.hasMore || requested) ? (
        <OlderNotifications loading={props.loadingMore} hasMore={props.hasMore} onMore={more} />
      ) : null}
      {mode === "empty" && vestingClaimCount === 0 ? (
        <EmptyState action={<ButtonLink href="/settings#settings-notifications" size="sm" variant="ghost">Notification settings</ButtonLink>} framed title="No notifications yet">
          Presale updates, unlocks and activity from people you follow.
        </EmptyState>
      ) : null}
      {mode === "error" ? (
        <EmptyState action={<Button onClick={props.onRetry} size="sm">Try again</Button>} framed role="alert" title={<>Your notifications couldn&rsquo;t load</>}>
          {props.errorMessage ?? diagnosticMessage("Check your connection, then try again.")}
        </EmptyState>
      ) : null}
      {mode === "visitor" ? <EmptyState action={props.signIn} framed title="Sign in to see your notifications" /> : null}
      {mode === "no-account" ? <EmptyState framed title="Finish setting up your account" /> : null}
    </div>
  );
}

function OlderNotifications({ loading = false, hasMore, onMore }: Readonly<{ loading?: boolean; hasMore?: boolean; onMore: () => Promise<void> }>) {
  return <div className={styles.more}>
    <Button aria-disabled={!hasMore || undefined} focusableDisabled loading={loading} loadingLabel="Loading older notifications" onClick={() => { if (hasMore && !loading) void onMore(); }} size="sm">
      {hasMore ? "Show older" : "All notifications loaded"}
    </Button>
  </div>;
}
