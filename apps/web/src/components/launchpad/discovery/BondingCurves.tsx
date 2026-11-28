"use client";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ago } from "@blast/core/lib/format.ts";
import type { DiscoveryResponse, DiscoveryRow, DiscoveryViewName } from "@blast/core/modules/launchpad-discovery/rows.ts";
import { Button } from "#web/components/blast-ui/Button.tsx";
import { EmptyState } from "#web/components/blast-ui/EmptyState.tsx";
import { Pager } from "#web/components/blast-ui/Pager.tsx";
import { SkeletonBox, SkeletonRows, SkeletonText } from "#web/components/blast-ui/Skeleton.tsx";
import { CoinMark } from "#web/components/blast-ui/CoinMark.tsx";
import { COIN_VERIFIED_LABEL, CoinVerifiedMark } from "#web/components/blast-ui/Icons.tsx";
import { ListsLate } from "#web/components/blast-ui/ServiceStatus.tsx";
import { useListsLate } from "#web/components/blast-ui/service-status.ts";
import { useAppQueryClient } from "#web/lib/query/provider.tsx";
import { queryKeys } from "#web/lib/query/keys.ts";
import { useLiveDiscovery, liveDiscoveryPage } from "./discovery-live.ts";
import { readRailPage } from "./discovery-client";
import { shortCoinType } from "#web/components/social/coins/coin-display.ts";
import { bpsPercent } from "@blast/core/lib/bps.ts";
import { compactQuoteAmount, quoteSymbol } from "./discovery-model";
import styles from "./BondingCurves.module.css";

/** The two curve stages Blast mode's Discover rail lists (owner ruling 2026-11-20: no Graduated stage there, no refresh button); Home shows three columns (`HomeBondingCurves`). */
type Stage = Exclude<DiscoveryViewName, "graduated">;

const VIEWS: readonly (readonly [Stage, string])[] = [
  ["new", "New"],
  ["near_graduation", "Almost graduated"],
];

const EMPTY: Readonly<Record<Stage, string>> = {
  new: "No bonding curves yet",
  near_graduation: "No curve is almost graduated",
};

/** Opens a curve's coin in Blast Mode's middle instead of following the row to its page. */
export type BondingOpen = Readonly<{ open: (row: DiscoveryRow) => void; isOpen: (row: DiscoveryRow) => boolean }>;

/**
 * Launchpad discovery by stage for Blast Mode's Discover rail: a row opens its coin in the middle.
 * With no curve at 60% yet, Almost graduated leaves the stage switch and the rail shows New,
 * keeping the saved stage so it comes back with its first curve.
 */
export function BondingCurves({ view: saved, onViewChange, now, onOpen }: Readonly<{
  view: DiscoveryViewName;
  onViewChange: (next: DiscoveryViewName) => void;
  now: () => number;
  onOpen: BondingOpen;
}>) {
  const client = useAppQueryClient();
  // Each stage pages on its own; a stage's pages restart when it is chosen again.
  const [paging, setPaging] = useState<Readonly<{ view: Stage; cursors: readonly (string | null)[]; page: number }>>({ view: saved === "near_graduation" ? saved : "new", cursors: [null], page: 1 });
  const live = useLiveDiscovery(paging.page === 1);
  // Almost graduated's first page, from the stream or the last read of it; reading it is the stage's own query below.
  const almostRead = useQuery({ ...railQuery("near_graduation", null), enabled: false }, client);
  const almostEmpty = isEmpty(liveDiscoveryPage(live.pages.near_graduation, almostRead.data));
  // A setup saved while Graduated was a stage opens on New.
  const view: Stage = saved === "graduated" || (saved === "near_graduation" && almostEmpty) ? "new" : saved;
  const current = paging.view === view ? paging : { view, cursors: [null], page: 1 };
  const cursor = current.cursors[current.page - 1] ?? null;
  const [fallbackInterval] = useState(() => 25_000 + Math.round(Math.random() * 10_000));
  const read = useQuery(
    {
      ...railQuery(view, cursor),
      // A next page keeps the current rows until it arrives; another stage starts from its skeleton.
      placeholderData: (previous, query) => (query?.queryKey[3] === view ? previous : undefined),
      retry: false,
      staleTime: 0,
      refetchOnMount: "always",
      refetchInterval: current.page === 1 && !live.live ? fallbackInterval : false,
    },
    client,
  );
  const choose = (next: Stage) => {
    if (next === view) return;
    setPaging({ view: next, cursors: [null], page: 1 });
    onViewChange(next);
  };
  const answer = current.page === 1 && !read.isPlaceholderData
    ? liveDiscoveryPage(live.pages[view], read.data)
    : read.data;
  const nextCursor = pageOf(answer)?.nextCursor ?? null;
  const selectPage = (next: number) => {
    if (next > current.page && (read.isPlaceholderData || !nextCursor)) return;
    const cursors = [...current.cursors];
    if (next === current.page + 1 && cursors[next - 1] !== nextCursor) {
      cursors.splice(next - 1, cursors.length, nextCursor);
    }
    setPaging({ view, cursors, page: next });
  };
  return (
    <>
      <div className={styles.controls}>
        {/* Pills like the Coins tab's Trending / New / Saved: a light second row under Discover's tabs, not a second track. */}
        <div className={styles.stages} role="group" aria-label="Curve stage">
          {VIEWS.filter(([key]) => key !== "near_graduation" || !almostEmpty).map(([key, label]) => (
            <Button key={key} variant="segment" size="xs" type="button" aria-pressed={view === key} onClick={() => choose(key)}>{label}</Button>
          ))}
        </div>
      </div>
      <BondingResult
        view={view}
        now={now}
        answer={answer}
        failed={read.isError && !live.live}
        pending={read.isPlaceholderData}
        busy={read.isFetching}
        onRetry={() => void read.refetch()}
        onOpen={onOpen}
      />
      {answer && (nextCursor !== null || current.page > 1) && (
        <div className={styles.footer}>
          {/* Cursor pages: the total is unknown, so the pager reads "Page N" with the next page while one exists. */}
          <Pager what="bonding curves" page={current.page} hasMore={nextCursor !== null} pending={read.isPlaceholderData} onPage={selectPage} />
        </div>
      )}
    </>
  );
}

/** One rail page's read; a stage's first page shares its cache entry with the check for an empty Almost graduated. */
function railQuery(view: Stage, cursor: string | null) {
  return {
    queryKey: [...queryKeys.workspace.bonding, view, cursor],
    queryFn: async () => {
      const answer = await readRailPage(view, cursor);
      if (answer === null || answer.section.state === "unavailable") throw new Error("Bonding curves could not load.");
      return answer;
    },
  };
}

/** Whether an answer has settled on no rows: a read still loading or failed is not empty. */
function isEmpty(answer: DiscoveryResponse | undefined): boolean {
  return answer?.section.state === "empty" || pageOf(answer)?.rows.length === 0;
}

/** The served rows, or null while the answer has none (empty or not loaded). */
function pageOf(answer: DiscoveryResponse | undefined) {
  if (!answer) return null;
  const { section } = answer;
  return section.state === "available" || section.state === "stale" ? section.data : null;
}

function BondingResult({
  view,
  now,
  answer,
  failed,
  pending,
  busy,
  onRetry,
  onOpen,
}: Readonly<{
  view: Stage;
  now: () => number;
  answer: DiscoveryResponse | undefined;
  failed: boolean;
  pending: boolean;
  busy: boolean;
  onRetry: () => void;
  onOpen: BondingOpen;
}>) {
  const late = useListsLate();
  const page = pageOf(answer);
  // While lists are late an empty or failed read says so (with its own Try again), instead of "none".
  if (late && !page?.rows.length && (answer || failed)) return <div className={styles.state}><ListsLate /></div>;
  if (!answer) {
    return failed ? (
      <div className={styles.state}>
        <EmptyState listEmpty role="alert" title="Bonding curves couldn’t load" action={<Button variant="secondary" size="sm" type="button" onClick={onRetry}>Retry</Button>}>
          The launchpad did not answer, so try again in a moment.
        </EmptyState>
      </div>
    ) : (
      <BondingRowsSkeleton count={8} />
    );
  }
  return (
    <>
      {answer.section.state === "stale" && <p role="status" className={styles.note}>Showing the last loaded curves. The launchpad is catching up.</p>}
      {failed && (
        <p role="alert" className={styles.note}>
          Bonding curves couldn’t refresh. Showing the previous result.{" "}
          <Button variant="ghost" size="sm" type="button" onClick={onRetry}>Retry</Button>
        </p>
      )}
      {page && page.rows.length > 0
        ? <BondingRows view={view} nowMs={now()} rows={page.rows} pending={pending} busy={busy} onOpen={onOpen} />
        : <div className={styles.state}><EmptyState listEmpty title={EMPTY[view]} /></div>}
    </>
  );
}

function BondingRows({
  view,
  nowMs,
  rows,
  pending,
  busy,
  onOpen,
}: Readonly<{
  view: Stage;
  nowMs: number;
  rows: readonly DiscoveryRow[];
  pending: boolean;
  busy: boolean;
  onOpen: BondingOpen;
}>) {
  if (busy && pending) return <BondingRowsSkeleton count={rows.length} />;
  return (
    <ol className={styles.list} aria-label={`${(VIEWS.find(([key]) => key === view)?.[1] ?? view)} bonding curves`} aria-busy={busy || undefined}>
      {rows.map((row) => <BondingRow key={row.launchId} view={view} row={row} nowMs={nowMs} onOpen={onOpen} />)}
    </ol>
  );
}

/** Curves still loading (the first read, or the next page): the board's coin rows in place, with no names or figures yet. */
function BondingRowsSkeleton({ count }: Readonly<{ count: number }>) {
  return (
    <SkeletonRows className={styles.list} count={count} label="Loading bonding curves" rowClassName={styles.row}>
      <SkeletonBox className={styles.tile} />
      <span className={styles.text}>
        <strong><SkeletonText>Coin name</SkeletonText></strong>
        <span><SkeletonText>Curve detail</SkeletonText></span>
      </span>
      <span className={styles.figs}>
        <b><SkeletonText>00.0%</SkeletonText></b>
        <span><SkeletonText>0h ago</SkeletonText></span>
      </span>
    </SkeletonRows>
  );
}

function BondingRow({ view, row, nowMs, onOpen }: Readonly<{ view: Stage; row: DiscoveryRow; nowMs: number; onOpen: BondingOpen }>) {
  const title = row.symbol ?? row.name ?? shortCoinType(row.coinType);
  const subtitle = row.symbol !== null && row.name !== null ? row.name : null;
  // Each figure is named for assistive tech.
  const progress = row.progressBps === null ? null : bpsPercent(row.progressBps);
  const detail = rowDetail(view, row, nowMs);
  const detailName = view === "new" ? "Launched " : "";
  const body = (
    <>
      <span className={styles.tile}>
        <CoinMark coin={{ key: row.coinType, coinType: row.coinType, symbol: row.symbol ?? undefined, iconUrl: row.iconUrl, round: false }} size={34} />
      </span>
      <span className={styles.text}>
        <strong>{row.verifiedTeam ? <span className="coinNamed sm"><span className="nm">{title}</span><CoinVerifiedMark size="sm" /></span> : title}</strong>
        {subtitle && <span>{subtitle}</span>}
      </span>
      <BondingRowFigures progress={progress} detail={detail} detailName={detailName} />
    </>
  );
  // The whole row is one button that opens the coin in the middle; its content passes the pointer through.
  const open = onOpen.isOpen(row);
  return (
    <li>
      <div className={styles.row} data-open={open || undefined}>
        <Button variant="ghost" size="sm" aria-current={open ? "true" : undefined} aria-label={`Open ${title}${row.verifiedTeam ? `, ${COIN_VERIFIED_LABEL}` : ""}`} className={styles.open} onClick={() => onOpen.open(row)} type="button" />
        {body}
      </div>
    </li>
  );
}

/** The row's second figure: how long ago it launched, or the quote left to graduate. */
function rowDetail(view: Stage, row: DiscoveryRow, nowMs: number): string | null {
  switch (view) {
    case "new":
      return timeAgo(row.createdAtMs, nowMs);
    case "near_graduation":
      return row.quoteRemaining === null ? null : `${compactQuoteAmount(row.quoteRemaining, row.quoteDecimals, row.quoteType)} ${quoteSymbol(row.quoteType)} to go`;
  }
}

function timeAgo(ms: number, nowMs: number): string {
  const text = ago(ms, nowMs);
  return text === "now" ? "Just now" : `${text} ago`;
}

function BondingRowFigures({ progress, detail, detailName }: Readonly<{ progress: string | null; detail: string | null; detailName: string }>) {
  if (!progress && !detail) return null;
  return <span className={styles.figs}>
    {progress && <b className="num">{progress}<span className="sr"> to graduation</span></b>}
    {detail && <span className="num">{detailName && <span className="sr">{detailName}</span>}{detail}</span>}
  </span>;
}
