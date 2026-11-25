"use client";

import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import clsx from "clsx";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { Button, ButtonLink, IconButton } from "#web/components/blast-ui/Button.tsx";
import { CloseIcon } from "#web/components/blast-ui/Icons.tsx";
import { EmptyState } from "#web/components/blast-ui/EmptyState.tsx";
import { PendingPanel } from "#web/components/blast-ui/PendingPanel.tsx";
import { publicErrorMessage } from "#web/lib/errors.ts";
import { pollInterval } from "#web/lib/query/polling.ts";
import { useAppQueryClient } from "#web/lib/query/provider.tsx";
import type { AsOf } from "@blast/core/web/contracts/items.ts";
import { SOCIAL_FEED_DELAYED_LAG_MS } from "@blast/core/web/contracts/feed.ts";
import { HOME_COINS_MAX_IDS, type HomeCoinsPage, type HomeQuery, type HomeSort, type HomeSource, type HomeWindow } from "@blast/core/web/contracts/home.ts";

import { useSignInGate, useSocialViewer } from "../SignInGate";
import { useWatchlistSnapshot, useWatchlistRetry, useWatchStar } from "../watchlist/Watchlist";
import { CoinCard } from "./CoinCard";
import styles from "./CoinHome.module.css";
import { coinsByIdsQuery, discoverQuery, followingCoinsQuery } from "./home-client";
import { resultsAnnouncement, SORT_LABELS } from "./home-state";
import { homeCoinKey } from "./home-model";
import { TableFooter } from "./TableFooter";
import { countWords } from "@blast/core/web/format.ts";
import { amtExact, atLeastPow10, exactAtoms, qtyExact } from "@blast/core/web/exact-amount.ts";
import type { FeedFreshnessSource } from "../home/feed-freshness";
import { useHomeLive } from "./use-home-live";
import { newerHomePrice, useHomePrices } from "./use-home-prices";
import { useLiveCoins, type RankedCoin } from "./use-live-coins";
import { useRankMotion } from "./use-rank-motion";
import { useRankings, type Rankings } from "./use-rankings";
import { RankingControls, useRankingsSlot } from "./RankingControls";

/** What every source list shares: the view and the clock. */
export type ListProps = Readonly<{
  source: HomeSource;
  window: HomeWindow;
  nowMs: number;
  trading: boolean;
  /** Discover's order and how to change it (the header's Vol and Age sort); the other sources keep their own order. */
  onReset?: () => void;
  onWindow?: (window: HomeWindow) => void;
  marketLoading?: boolean;
  sort?: HomeSort;
  defaultSort?: HomeSort;
  streamPrices?: boolean;
  onSort?: (sort: HomeSort) => void;
  /** The list's page (the URL's) and the device's rows per page, and how to change them. */
  page: number;
  rows: number;
  onPage: (page: number, scroll?: boolean) => void;
  onRows: (rows: number) => void;
}>;

/** Each source owns its result announcement alongside the data it renders. */
function ResultsAnnouncement({ props, count, pages }: Readonly<{ props: ListProps; count: number; pages: number }>) {
  return <p aria-live="polite" className="sr" role="status">{resultsAnnouncement({ source: props.source, page: props.page, sort: props.sort ?? "relevant", window: props.window }, count, pages)}</p>;
}

/** The footer under a list: rows per page and the count ("45 coins") on the left, the pager on the right. */
function listPager(props: ListProps, page: number, pages: number, total: number | undefined, pending = false): ReactNode {
  return <TableFooter pending={pending} count={total === undefined ? undefined : countWords(total, "coin", "coins")} rows={props.rows} onRows={props.onRows} onPage={props.onPage} page={page} pages={pages} what="coins" />;
}

/** A page asked for beyond the end (a shorter list since the link was made) settles on the last page, once the answer is in. */
function useLastPage(page: number, pages: number | undefined, onPage: ListProps["onPage"]): void {
  useEffect(() => {
    if (pages !== undefined && page > pages) onPage(pages, false);
  }, [page, pages, onPage]);
}

/** A column label that sorts the list when it can: the arrow marks the order in force; the same label again returns to the default. */
function SortHead({ label, by, sort, defaultSort, onSort, className }: Readonly<{ label: string; by: HomeSort; sort?: HomeSort; defaultSort: HomeSort; onSort?: (sort: HomeSort) => void; className: string }>) {
  if (!onSort) return <span className={className}>{label}</span>;
  const on = sort === by;
  return (
    <button aria-pressed={on} className={clsx(className, styles.sortHead)} data-on={on || undefined} onClick={() => onSort(on ? defaultSort : by)} title={on ? `Back to ${SORT_LABELS[defaultSort]}` : `Sort by ${label.toLowerCase()}`} type="button">
      {on ? <span aria-hidden="true">↓ </span> : null}{label}
    </button>
  );
}

/**
 * The columns' one header per list (the Main board's: `#`, Coin, Price,
 * price change, Volume, FDV, Top 10, Age and 7d; a phone stacks the
 * figures and needs none). Volume and Age sort the list where it has an
 * order (Discover).
 */
export function ListHead({ sort, defaultSort = "relevant", onSort, window }: Pick<ListProps, "sort" | "defaultSort" | "onSort" | "window">) {
  return <div className={clsx(styles.listHead, styles.cols)}>
    <span className={styles.hRank}>#</span>
    <span className={styles.hIdent}>Coin</span>
    <span className={styles.hPrice}>Price</span>
    <span className={styles.hChange}>{window}</span>
    <SortHead by="trending" className={styles.hVol} defaultSort={defaultSort} label="Volume" onSort={onSort} sort={sort} />
    <span className={styles.hFdv}>FDV</span>
    <span className={styles.hTop}>Top 10</span>
    <SortHead by="newest" className={styles.hAge} defaultSort={defaultSort} label="Age" onSort={onSort} sort={sort} />
    <span className={styles.hWeek}>Trend</span>
  </div>;
}

/**
 * Live rows under one header; only background rank changes move into place.
 * With no rows (a `result` in their place) the pager, count go;
 * a settled `empty` result drops the column header and its sorts too.
 */
export function CoinList({ coins, props, result, empty = false, end, viewKey, rankings, checkpoint = 0, buy, swapping = false }: Readonly<{ coins: readonly RankedCoin[]; props: ListProps; result?: ReactNode; empty?: boolean; end?: ReactNode; viewKey?: string; rankings?: Rankings; checkpoint?: number; buy?: Readonly<{ coinKey: string; amount: string }>; /** The previous view's rows, held while the new view loads. */ swapping?: boolean }>) {
  // A new sort or filter re-ranks the same list, so its rows slide; another source or page starts fresh.
  const list = useRankMotion(JSON.stringify([viewKey ?? [props.source, props.window, props.sort, props.page, props.rows], rankings?.motionVersion]), JSON.stringify([props.source, props.page, props.rows]));
  const hasResult = Boolean(result);
  const latest = useHomePrices(coins, props.streamPrices === true && !hasResult);
  // Home shows new-coin admissions in the Coins header.
  const slotted = useRankingsSlot(rankings);
  const controls = rankings && !slotted ? <RankingControls rankings={rankings} /> : null;
  const header = <ListHead defaultSort={props.defaultSort} window={props.window} onSort={props.source === "discover" ? props.onSort : undefined} sort={props.sort} />;
  if (result) return <>
    {controls}
    {empty ? null : header}
    <div aria-busy={props.marketLoading || undefined} className={styles.coinResult} data-list-none={empty || undefined}>{result}</div>
  </>;
  return (
    <>
      {controls}
      {coins.length > 0 ? <span className={styles.phoneWindow}>{props.window === "1h" ? "1 hour" : "24 hours"}</span> : null}
      {header}
      <ol aria-busy={swapping || undefined} className={clsx(styles.list, styles.rankedList)} data-swapping={swapping || undefined} data-volume-sort={props.source === "discover" && props.sort === "trending" || undefined} ref={list} {...rankings?.interactionProps}>
        {coins.map((coin, index) => (
          <CoinCard
            key={homeCoinKey(coin)}
            coin={coin}
            buyAmount={buy?.coinKey === homeCoinKey(coin) ? buy.amount : undefined}
            rank={(props.page - 1) * props.rows + index + 1}
            livePrice={props.streamPrices ? newerHomePrice(latest, coin, coin.readCheckpoint ?? checkpoint) : undefined}
            nowMs={props.nowMs}
            trading={props.trading}
            watchlist={props.source === "watchlist"}
            window={props.window}
          />
        ))}
      </ol>
      <div data-table-end="">{end}</div>
    </>
  );
}

function listReadError(read: Pick<UseQueryResult, "error" | "isError" | "isFetching">, loaded: boolean, onRetry: () => void): ReactNode {
  if (!read.isError || (!loaded && read.isFetching)) return null;
  return <ListError error={read.error} loaded={loaded} onRetry={onRetry} retrying={read.isFetching} />;
}

function ListError({ loaded, onRetry, error, retrying }: Readonly<{ loaded: boolean; onRetry: () => void; error: unknown; retrying: boolean }>) {
  const retry = <Button aria-disabled={retrying} onClick={() => { if (!retrying) onRetry(); }} size="sm">Retry</Button>;
  return (
    <div className={styles.end}>
      {loaded ? <p role="alert">Couldn’t refresh the coins. Showing the previous result.</p>
        : <EmptyState action={retry} compact listEmpty role="alert" title="Couldn’t load the coins" />}
      <details className={styles.diagnostics}><summary>Diagnostics</summary>{publicErrorMessage(error)}</details>
      {loaded ? retry : null}
    </div>
  );
}

/** "Activity is delayed" (spec AC-042): the read's chain lag over a minute, said over the data it has. */
function FreshnessNote({ asOf }: Readonly<{ asOf: AsOf | null | undefined }>) {
  if (!asOf || asOf.lag_ms <= SOCIAL_FEED_DELAYED_LAG_MS) return null;
  return (
    <p className={styles.delayed} role="status">
      <strong>Activity is delayed.</strong> The chain is being indexed {Math.round(asOf.lag_ms / 60_000)} min behind; recent trades may be missing for a moment, and everything shown stays accurate.
    </p>
  );
}

/** The Following source's empty states: nobody followed yet, or a quiet window. */
function FollowingEmpty({ following, props, onDiscover }: Readonly<{ following: number; props: ListProps; onDiscover: () => void }>) {
  if (following === 0) return <EmptyState action={<Button onClick={onDiscover} size="sm">Discover coins</Button>} title="You’re not following anyone yet" />;
  const hourly = props.window === "1h";
  return <EmptyState
    action={hourly && props.onWindow ? <Button onClick={() => props.onWindow?.("24h")} size="sm">View 24 hours</Button> : undefined}
    title={hourly ? "No activity in the last hour" : "No activity in the last 24 hours"}
  />;
}

/** Discover: the public ranking, with the server's first page as its first answer. */
function settledHomePage(read: Pick<UseQueryResult<HomeCoinsPage>, "data" | "isPlaceholderData">) {
  return read.isPlaceholderData ? undefined : read.data;
}

export function DiscoverPending({ props }: Readonly<{ props: ListProps }>) {
  return (
    <CoinList
      coins={[]}
      props={props}
      result={<PendingPanel label="Loading coins" />}
    />
  );
}

function holdNewCoins(query: HomeQuery): boolean {
  return query.sort === "newest" && query.page === 1 && query.cursor === null;
}

function useHomeBuyCue(query: HomeQuery, settled: boolean, showBuys: boolean | undefined, freshness: FeedFreshnessSource | undefined, coins: readonly RankedCoin[]) {
  const view = JSON.stringify(query);
  const [buyCue, setBuyCue] = useState<{ view: string; coinKey: string; symbol: string; amount: string }>();
  const nextCueAt = useRef(0);
  useEffect(() => {
    if (!buyCue) return;
    const timeout = window.setTimeout(() => setBuyCue(undefined), 900);
    return () => window.clearTimeout(timeout);
  }, [buyCue]);
  useHomeLive(query, settled, freshness, buys => {
    const now = performance.now();
    if (now < nextCueAt.current || !showBuys) return;
    const listed = new Map(coins.map(coin => [homeCoinKey(coin), coin.symbol]));
    const buy = buys.filter(event => listed.has(event.coin_key))
      .sort((a, b) => b.occurred_at_ms - a.occurred_at_ms)[0];
    if (!buy) return;
    const value = exactAtoms(buy.quote_atoms, buy.quote_decimals);
    if (!value) return;
    const amount = atLeastPow10(value, 0) ? qtyExact(value) : amtExact(value);
    nextCueAt.current = now + 1_000;
    setBuyCue({ view, coinKey: buy.coin_key, symbol: listed.get(buy.coin_key)!, amount: `${amount}\u00a0${buy.quote_symbol}` });
  });
  return settled && buyCue?.view === view ? buyCue : undefined;
}

export function DiscoverList({ query, initial, props, freshness }: Readonly<{ query: HomeQuery; initial: HomeCoinsPage | null; props: ListProps; freshness?: FeedFreshnessSource }>) {
  const client = useAppQueryClient();
  const read = useQuery({ ...discoverQuery(query, true), initialData: initial ?? undefined }, client);
  const settled = settledHomePage(read);
  // Keep populated rows during a view change, but only show an empty message for the current view.
  const previous = read.isPlaceholderData && read.data?.coins.length ? read.data : undefined;
  const data = settled ?? previous;
  const rankings = useRankings(settled?.coins, JSON.stringify(query), {
    holdIncoming: holdNewCoins(query),
    checkpoint: settled?.as_of?.checkpoint,
  });
  const coins = previous?.coins ?? rankings.coins;
  const buy = useHomeBuyCue(query, settled !== undefined, props.streamPrices, freshness, coins);
  useLastPage(props.page, settled?.pages, props.onPage);

  const refresh = () => void read.refetch({ cancelRefetch: false });
  const error = listReadError(read, data !== undefined, refresh);
  const result = data === undefined
    ? error ?? <PendingPanel label="Loading coins" />
    : coins.length === 0 ? <DiscoverEmpty query={query} onReset={props.onReset} /> : null;

  return (
    <>
      <span className="sr-only" role="status">{buy ? `${buy.symbol} buy for ${buy.amount}` : ""}</span>
      {data ? <ResultsAnnouncement props={props} count={data.total} pages={data.pages} /> : null}
      <FreshnessNote asOf={data?.as_of} />
      <CoinList
        checkpoint={previous?.as_of?.checkpoint}
        buy={buy}
        rankings={rankings}
        viewKey={JSON.stringify([query, read.isPlaceholderData])}
        coins={coins}
        end={listPager(props, props.page, data?.pages ?? 1, data?.total, read.isPlaceholderData)}
        props={{ ...props, marketLoading: data !== undefined && read.isFetching }}
        result={result}
        empty={data === undefined ? error !== null : coins.length === 0}
        swapping={previous !== undefined}
      />
      {data ? error : null}
    </>
  );
}

type DiscoverEmptyProps = Readonly<{ query: HomeQuery; onReset?: () => void; compact?: boolean }>;

export function DiscoverEmpty({ query, onReset, compact }: DiscoverEmptyProps) {
  const filtered = query.minParticipants > 0 || query.age !== "all" || query.tradable;
  if (!filtered) return <DiscoverCatalogEmpty compact={compact} />;
  return <FilteredDiscoverEmpty compact={compact} onReset={onReset} query={query} />;
}

function DiscoverCatalogEmpty({ compact }: Readonly<{ compact?: boolean }>) {
  return <EmptyState compact={compact} listEmpty role="status" title="No coins to discover" />;
}

function FilteredDiscoverEmpty({ query, onReset, compact }: DiscoverEmptyProps) {
  const client = useAppQueryClient();
  const unfiltered = useQuery(discoverQuery({ ...query, minParticipants: 0, age: "all", tradable: false, page: 1, cursor: null }), client);
  const total = settledHomePage(unfiltered)?.total;
  if (total === 0) return <DiscoverCatalogEmpty compact={compact} />;
  return <EmptyState
    action={onReset && total !== undefined && total > 0 ? <Button onClick={onReset} size="sm">Reset filters</Button> : undefined}
    compact={compact}
    role="status"
    title="No coins match these filters"
  />;
}

/** The sign-in state of a personal source (the brief's §5): a plain invitation, nothing filled in. */
function SignInState({ what }: Readonly<{ what: string }>) {
  const gate = useSignInGate();
  return <EmptyState action={<ButtonLink href={gate.signInHref} onClick={gate.openSignIn} prefetch={false} size="sm">Sign in</ButtonLink>} title={`Sign in to see ${what}`} />;
}

/** Personal lists refresh their market figures while visible. */
const PERSONAL_MARKET_POLL_MS = 60_000;

function useFollowingRead(props: ListProps) {
  const viewer = useSocialViewer();
  const client = useAppQueryClient();
  const token = viewer.getAccessToken;
  const enabled = viewer.signedIn && token !== undefined && viewer.callsign !== null;
  const read = useQuery({
    ...followingCoinsQuery(token ?? (async () => null), viewer.callsign ?? "", props.window, props.page, props.rows, true),
    enabled,
    refetchInterval: (query) => pollInterval(PERSONAL_MARKET_POLL_MS, query),
  }, client);
  return { read, viewer };
}

/** Following: strictly the accounts the viewer follows. */
export function FollowingList({ props, onDiscover }: Readonly<{ props: ListProps; onDiscover: () => void }>) {
  return <div className={styles.personalResult}><FollowingContent props={props} onDiscover={onDiscover} /></div>;
}

function followingAccountState(viewer: ReturnType<typeof useSocialViewer>) {
  if (viewer.sessionPending) return <PendingPanel label="Restoring your session" />;
  if (!viewer.signedIn) return <SignInState what="who you follow" />;
  if (!viewer.callsign) return <EmptyState role="alert" title="Your account is unavailable">Reload to restore your account and followed coins.</EmptyState>;
  return null;
}

function FollowingContent({ props, onDiscover }: Readonly<{ props: ListProps; onDiscover: () => void }>) {
  const { read, viewer } = useFollowingRead(props);
  // As in Discover: the previous page stays on screen while the next loads, outside the live list.
  const settled = read.isPlaceholderData ? undefined : read.data;
  const rankings = useRankings(settled?.coins, JSON.stringify(["following", props.window, viewer.callsign, props.page, props.rows]), { checkpoint: settled?.as_of?.checkpoint });
  const liveCoins = rankings.coins;
  const data = settled ?? read.data;
  const coins = read.isPlaceholderData ? read.data?.coins ?? liveCoins : liveCoins;
  useLastPage(props.page, settled?.pages, props.onPage);
  const accountState = followingAccountState(viewer);
  if (accountState) return accountState;
  const refresh = () => void read.refetch({ cancelRefetch: false });
  const error = listReadError(read, data !== undefined, refresh);
  if (data === undefined || (read.isPlaceholderData && coins.length === 0)) {
    return error ?? <PendingPanel label="Loading coins" />;
  }
  return (
    <>
      <ResultsAnnouncement props={props} count={data.total} pages={data.pages} />
      <FreshnessNote asOf={data.as_of} />
      <CoinList
        checkpoint={read.isPlaceholderData ? data.as_of?.checkpoint : undefined}
        rankings={rankings}
        viewKey={JSON.stringify([props.source, props.window, viewer.callsign, props.page, props.rows, read.isPlaceholderData])}
        coins={coins}
        end={listPager(props, props.page, data.pages, data.total, read.isPlaceholderData)}
        props={{ ...props, marketLoading: read.isFetching }}
        result={coins.length === 0 ? <FollowingEmpty following={data.following ?? 0} onDiscover={onDiscover} props={props} /> : null}
        empty
      />
      {error}
    </>
  );
}

/** A saved sale or curve coin the web no longer shows: said so, with the way to let it go. */
function UnavailableRow({ presaleId }: Readonly<{ presaleId: string }>) {
  const star = useWatchStar({ presale_id: presaleId, name: "this coin" });
  return (
    <li className={clsx("card", styles.unavailable)}>
      <span>
        <b>Saved coin unavailable</b>
        <span className={clsx("mono", styles.unavailableId)}>{presaleId.slice(0, 6)}…{presaleId.slice(-4)}</span>
        <span>It is no longer listed on Blast.</span>
      </span>
      <IconButton aria-label="Remove unavailable coin from watchlist" onClick={star.toggle} size="touch" title="Remove from watchlist"><CloseIcon /></IconButton>
    </li>
  );
}

/** The Watchlist: the viewer's saved sales and curve coins, in the saved order, nothing recommended. */
export function WatchlistList({ props }: Readonly<{ props: ListProps }>) {
  return <div className={styles.personalResult}><WatchlistContent props={props} /></div>;
}

function WatchlistContent({ props }: Readonly<{ props: ListProps }>) {
  const viewer = useSocialViewer();
  const client = useAppQueryClient();
  const snapshot = useWatchlistSnapshot();
  const retryWatchlist = useWatchlistRetry();
  const ids = [...snapshot.ids].slice(0, HOME_COINS_MAX_IDS);
  const query = useQuery({
    ...coinsByIdsQuery(ids, props.window, undefined, true),
    enabled: viewer.signedIn && ids.length > 0,
    refetchInterval: (query) => pollInterval(PERSONAL_MARKET_POLL_MS, query),
  }, client);
  const liveCoins = useLiveCoins(query.data?.coins, `watchlist:${viewer.callsign ?? "public"}:${props.window}:${ids.join(",")}`, { checkpoint: query.data?.as_of?.checkpoint });
  // The saved sales are one read; the pages are cut here, at the device's rows per page.
  const pages = Math.max(1, Math.ceil(liveCoins.length / props.rows));
  const page = Math.min(props.page, pages);
  const shown = useMemo(() => liveCoins.slice((page - 1) * props.rows, page * props.rows), [liveCoins, page, props.rows]);
  useLastPage(props.page, query.data === undefined ? undefined : pages, props.onPage);
  if (viewer.sessionPending) return <PendingPanel label="Restoring your session" />;
  if (!viewer.signedIn) return <SignInState what="your watchlist" />;
  if (snapshot.status === "loading" || snapshot.status === "idle") return <PendingPanel label="Loading your watchlist" />;
  if (snapshot.status === "error") {
    return <EmptyState action={<Button onClick={retryWatchlist} size="sm">Retry</Button>} listEmpty role="alert" title="Your watchlist couldn’t load" />;
  }
  if (ids.length === 0) {
    return <EmptyState action={<ButtonLink href="/presale" size="sm">Browse presales</ButtonLink>} title="No saved coins">Save a coin to follow it here.</EmptyState>;
  }
  const refresh = () => void query.refetch({ cancelRefetch: false });
  const error = listReadError(query, query.data !== undefined, refresh);
  if (query.data === undefined) return error ?? <PendingPanel label="Loading coins" />;
  const missing = query.data.missing;
  return (
    <>
      <ResultsAnnouncement props={props} count={liveCoins.length} pages={pages} />
      <FreshnessNote asOf={query.data.as_of} />
      <CoinList coins={shown} props={{ ...props, page, marketLoading: query.isFetching }} end={<>{missing.length > 0 ? <ul className={styles.list}>{missing.map((id) => <UnavailableRow key={id} presaleId={id} />)}</ul> : null}{listPager(props, page, pages, liveCoins.length)}</>} />
      {error}
      {snapshot.ids.size > HOME_COINS_MAX_IDS ? <p className={styles.caughtUp}>Showing your {HOME_COINS_MAX_IDS} most recently saved. Older saved sales are on the presales page’s Watchlist.</p> : null}
    </>
  );
}

/** Placeholder rows the size of a collapsed coin, so nothing jumps; the shell stays. */
export function ListSkeleton({ rows }: Readonly<{ rows: number }>) {
  return (
    <ol aria-busy="true" aria-label="Loading" className={styles.list} data-list-pending="" role="status">
      {Array.from({ length: rows }, (_, key) => key).map((key) => (
        <li aria-hidden="true" className={clsx(styles.item, styles.skeleton)} key={key}>
          <div className={clsx(styles.row, styles.cols)}>
            <span className={styles.ident}>
              <span className={styles.skMark} />
              <span className={styles.identText}>
                <span className={styles.skLine} data-w="40" />
                <span className={styles.skLine} data-w="30" />
              </span>
            </span>
          </div>
        </li>
      ))}
    </ol>
  );
}
