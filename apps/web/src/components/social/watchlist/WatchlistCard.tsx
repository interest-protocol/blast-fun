"use client";

import { diagnosticMessage, publicErrorCopy } from "#web/lib/errors.ts";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import clsx from "clsx";
import { IntentLink as Link } from "#web/components/blast-ui/NavigationLink.tsx";
import { useEffect, useMemo, useState } from "react";

import { Button, ButtonLink, IconButton } from "#web/components/blast-ui/Button.tsx";
import { DateStamp } from "#web/components/blast-ui/DateStamp.tsx";
import { EmptyState } from "#web/components/blast-ui/EmptyState.tsx";
import { BellIcon, COIN_VERIFIED_LABEL, CoinVerifiedMark } from "#web/components/blast-ui/Icons.tsx";
import { SkeletonText } from "#web/components/blast-ui/Skeleton.tsx";
import { useToast } from "#web/components/blast-ui/Toasts.tsx";
import { useAppQueryClient } from "#web/lib/query/provider.tsx";
import { NOT_OPEN_YET, opensAt } from "@blast/core/web/format.ts";
import { presalePath } from "@blast/core/modules/social/items/do-the-same.ts";

import { ChevIcon } from "../profile/icons";
import { PresaleMark } from "../profile/parts";
import styles from "../profile/Profile.module.css";
import { pricesByKey, salesPricesQuery } from "../prices/price-client";
import { useViewerFollow, useViewerStateStore } from "../ViewerState";
import { useWatchlistRows } from "./Watchlist";
import { WatchlistRowsSkeleton } from "./WatchlistSkeleton";
import { rowOfSummary, watchedCoin, watchedCoinIds, watchlistLine, watchlistOrder, type WatchlistRow } from "./watchlist-model";

/** A pending presale's bell: following the presale (§5.3; the bell is the follow, the star the watchlist). */
export function NotifyBell({ presale }: Readonly<{ presale: Pick<WatchlistRow, "presale_id" | "name"> }>) {
  const store = useViewerStateStore();
  const following = useViewerFollow({ kind: "presale", presale_id: presale.presale_id }) === true;
  const toast = useToast();
  return (
    <IconButton
      aria-label={`${following ? "Notifications on" : "Notify me"} for ${presale.name}`}
      aria-pressed={following}
      className={styles.notify}
      data-on={following || undefined}
      onClick={async () => {
        if (!store) return;
        // Shown at once; a refusal puts the bell back.
        const result = await store.setFollowing({ kind: "presale", presale_id: presale.presale_id }, !following);
        if (result.status !== "ok") toast("Notifications could not be saved", { sub: diagnosticMessage(publicErrorCopy(result.code), result) });
      }}
      size="xs"
      title={following ? "You’ll be notified" : "Notify me"}
    >
      <BellIcon />
    </IconButton>
  );
}

/** The live clock for open rows' "left" (a second's tick, as the design's timers), from the server's time so markup matches. */
function useClock(serverNowMs: number): number {
  const [now, setNow] = useState(serverNowMs);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, []);
  return now;
}

/**
 * The coin rows' last 24 hours (R3-20's public `GET /api/social/prices`, the
 * shared sales query Blast mode's lanes and the feed's moves make): each
 * sale's `change_24h_bps` once the read answered, null without one or when
 * it failed (the line is left out); a sale the read has not answered yet is
 * missing. A new set of coins keeps the last answer for the ones it had.
 */
function useWatchedChanges(rows: readonly WatchlistRow[]): ReadonlyMap<string, number | null> {
  const client = useAppQueryClient();
  const ids = watchedCoinIds(rows).join(",");
  const read = useQuery({ ...salesPricesQuery(ids), enabled: ids !== "", placeholderData: keepPreviousData }, client);
  const { data, isError, isPlaceholderData } = read;
  return useMemo(() => {
    const found = pricesByKey(data ?? null);
    const settled = isError || (data !== undefined && !isPlaceholderData);
    return new Map(ids.split(",").flatMap((id) => {
      const price = found.get(id);
      return price ? [[id, price.change_24h_bps] as const] : settled ? [[id, null] as const] : [];
    }));
  }, [ids, data, isError, isPlaceholderData]);
}

/**
 * The card itself, from rows (fixtures and tests render it directly); `changes` are the coin rows' 24-hour changes as
 * `useWatchedChanges` gives them. Without it the rows draw no change line, never a skeleton that never settles.
 */
export function WatchlistCardView({
  items,
  total,
  status,
  nowMs,
  onRetry,
  errorMessage,
  changes,
}: Readonly<{ items: readonly WatchlistRow[]; total: number; status: "loading" | "ready" | "error" | "visitor"; nowMs: number; onRetry?: () => void; errorMessage?: string; changes?: ReadonlyMap<string, number | null> }>) {
  return (
    <div className={clsx("card", styles.listCard)} data-aside-card="" aria-busy={status === "loading" || undefined}>
      <h3 className={styles.lcH}>
        <span>Watchlist</span>
        {total > 0 ? <span className={styles.num}>{total.toLocaleString("en-US")}</span> : null}
      </h3>
      {status === "error" && items.length === 0 ? (
        <EmptyState action={<Button onClick={onRetry} size="sm">Try again</Button>} className={styles.compactEmpty} role="alert" row title="Your watchlist couldn’t load">
          {errorMessage ?? diagnosticMessage("Try again.")}
        </EmptyState>
      ) : (status === "ready" || status === "visitor") && items.length === 0 ? (
        <EmptyState
          action={status === "ready" ? <ButtonLink href="/presale" size="sm" variant="ghost">Browse presales</ButtonLink> : undefined}
          className={styles.compactEmpty}
          row
          title="No saved presales"
        >
          Save a presale to find it here.
        </EmptyState>
      ) : null}
      {status === "loading" && items.length === 0 ? <WatchlistRowsSkeleton /> : null}
      {watchlistOrder(items).map((presale) => <WatchlistItem changeBps={changes ? changes.get(presale.presale_id) : null} key={presale.presale_id} nowMs={nowMs} presale={presale} />)}
    </div>
  );
}

function WatchlistOpening({ start }: Readonly<{ start: number }>) {
  const open = opensAt(start);
  return <span>{open === null ? NOT_OPEN_YET : <>Opens <DateStamp at={open} plain /></>}</span>;
}

/**
 * One row (the Portfolio board's three kinds): a presale now trading is a
 * coin, its ticker with the price over its 24-hour change; an open one its
 * fill and time left with a chevron; a pending one its opening with the bell.
 */
function WatchlistItem({ presale, nowMs, changeBps }: Readonly<{ presale: WatchlistRow; nowMs: number; changeBps: number | null | undefined }>) {
  const coin = watchedCoin(presale, changeBps);
  if (coin) {
    return (
      <Link aria-label={presale.verifiedTeam ? `${coin.label}, ${COIN_VERIFIED_LABEL}` : coin.label} className={styles.lrow} href={presalePath(presale.presale_id)}>
        <PresaleMark presale={presale} />
        {presale.verifiedTeam ? <span className={styles.tickNamed}><b className={styles.tick}>{presale.symbol}</b><CoinVerifiedMark /></span> : <b className={styles.tick}>{presale.symbol}</b>}
        <span className={styles.v}>
          <b>{coin.price}</b>
          {coin.move === "loading" ? <SkeletonText>+0.00%</SkeletonText> : coin.move ? <span className={styles[coin.move.tone]}>{coin.move.text}</span> : null}
        </span>
      </Link>
    );
  }
  if (presale.phase === "pending") {
    return (
      <div className={styles.lrow}>
        <PresaleMark presale={presale} />
        <Link className={styles.t} href={presalePath(presale.presale_id)}>
          {presale.verifiedTeam ? <span className={styles.named}><b>{presale.name}</b><CoinVerifiedMark /></span> : <b>{presale.name}</b>}
          <WatchlistOpening start={presale.start_ms} />
        </Link>
        <NotifyBell presale={presale} />
      </div>
    );
  }
  return (
    <Link className={styles.lrow} href={presalePath(presale.presale_id)}>
      <PresaleMark presale={presale} />
      <span className={styles.t}>
        {presale.verifiedTeam ? <span className={styles.named}><b>{presale.name}</b><CoinVerifiedMark /></span> : <b>{presale.name}</b>}
        <span>{watchlistLine(presale, nowMs)}</span>
      </span>
      <ChevIcon className={styles.chev} />
    </Link>
  );
}

/**
 * The right column's "Watchlist" (§5.5: own profile and Notifications): the
 * starred presales newest first, then the followed ones not starred (OA-17,
 * the design's `[...new Set([...starred, ...followed])]`; ten rows, the
 * header counts them all), a pending one with its bell, others with a
 * chevron; "No saved presales" when there are none (and for a
 * visitor, whose star asks to sign in). A signed-in viewer's rows come from
 * the watchlist store (live as stars and presale follows change); without
 * one the server’s given `rows` show.
 */
export function WatchlistCard({ rows: given, nowMs: serverNowMs }: Readonly<{
  rows?: readonly WatchlistRow[] | null;
  /** The server's time for the first render. */
  nowMs: number;
}>) {
  const { rows, signedIn, retry } = useWatchlistRows();
  const nowMs = useClock(serverNowMs);
  const items = !signedIn && given ? given : rows?.items.map((item) => rowOfSummary(item.presale)) ?? [];
  const changes = useWatchedChanges(items);
  if (!signedIn && given) {
    return <WatchlistCardView changes={changes} items={given} nowMs={nowMs} status="ready" total={given.length} />;
  }
  return (
    <WatchlistCardView
      changes={changes}
      errorMessage={rows?.errorMessage}
      items={items}
      nowMs={nowMs}
      onRetry={retry}
      status={!signedIn ? "visitor" : rows?.status ?? "loading"}
      total={rows?.total ?? 0}
    />
  );
}
