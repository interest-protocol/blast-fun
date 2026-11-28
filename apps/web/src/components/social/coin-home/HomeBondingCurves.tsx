"use client";

import { hoverExcerpt } from "#web/lib/hover-text.ts";
import { coinPagePath } from "@blast/core/modules/launchpad-coin/page-key.ts";
import { useId, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import clsx from "clsx";
import { ago } from "@blast/core/lib/format.ts";
import { bpsPercent } from "@blast/core/lib/bps.ts";
import type { DiscoveryMetrics, DiscoveryRow } from "@blast/core/modules/launchpad-discovery/rows.ts";
import { BLAST_V1_COINS, blastV1Coin } from "@blast/core/modules/social/portfolio/core-coins.ts";
import { Button } from "#web/components/blast-ui/Button.tsx";
import { CoinMark } from "#web/components/blast-ui/CoinMark.tsx";
import { CoinLegacyMark, CoinVerifiedMark } from "#web/components/blast-ui/Icons.tsx";
import { saveListContent, useListContent } from "#web/components/blast-ui/list-restoration.ts";
import { IntentLink } from "#web/components/blast-ui/NavigationLink.tsx";
import { Segmented } from "#web/components/blast-ui/Segmented.tsx";
import { SkeletonBox, SkeletonRegion, SkeletonText } from "#web/components/blast-ui/Skeleton.tsx";
import { liveDiscoveryPage, useLiveDiscovery } from "#web/components/launchpad/discovery/discovery-live.ts";
import { useAppQueryClient } from "#web/lib/query/provider.tsx";
import { readableUsd } from "#web/lib/market-format.ts";
import { bondingCatalogQuery, graduatedMarketCapQuery } from "../bonding/bonding-client.ts";
import { shortCoinType } from "../coins/coin-display.ts";
import { BONDING_COLUMN_ROWS, columnRows, graduatedColumnRows, homeAlmostColumn, homeNewColumn, type BondingColumn } from "./home-model";
import { TableCard } from "./TableFooter";
import styles from "./HomeBondingCurves.module.css";

/** Each column's name and what it says with no rows. */
const COLUMNS: readonly Readonly<{ key: BondingColumn; title: string; none: string }>[] = [
  { key: "new", title: "New", none: "No new curve under 60%." },
  { key: "almost", title: "Almost graduated", none: "No curve is at 60% yet." },
  { key: "graduated", title: "Graduated", none: "No curve has graduated yet." },
];

const STAGE_HISTORY_KEY = "home:bonding-stage";

/**
 * Home's Bonding Curves: one card, three columns (New, Almost graduated,
 * Graduated), each with the same row limit, including four Blast V1 coins in Graduated.
 * Narrow, the same columns become a switch that
 * shows one at a time. The visible tab shares its Discover stream with other live features.
 */
export function HomeBondingCurves({ nowMs }: Readonly<{ nowMs: number }>) {
  const client = useAppQueryClient();
  const id = useId();
  const [shown, setShown] = useState<BondingColumn>("new");
  useListContent(STAGE_HISTORY_KEY, shown, setShown, { restoreOnMount: true });
  const live = useLiveDiscovery(true);
  const [fallbackInterval] = useState(() => 25_000 + Math.round(Math.random() * 10_000));
  const closest = useQuery({
    ...bondingCatalogQuery("bonding", "progress", "", null),
    refetchInterval: live.live ? false : fallbackInterval,
  }, client);
  const closestAnswer = liveDiscoveryPage(live.pages.near_graduation, closest.data);
  const { needsCatalogTail } = homeNewColumn(live.pages.new, undefined, closestAnswer);
  const fresh = useQuery({
    ...bondingCatalogQuery("bonding", "newest", "", null),
    refetchInterval: !live.live || needsCatalogTail ? fallbackInterval : false,
  }, client);
  const freshAnswer = liveDiscoveryPage(live.pages.new, fresh.data);
  const { rows: newest } = homeNewColumn(freshAnswer, fresh.data, closestAnswer);
  const almost = homeAlmostColumn(closestAnswer, freshAnswer);
  const graduated = useQuery(graduatedMarketCapQuery(), client);
  const reads = { new: fresh, almost: closest, graduated } as const;
  const rowsByColumn = { new: newest, almost, graduated: columnRows("graduated", graduated.data) };
  const verified = new Set([...(fresh.data?.verifiedTeam ?? []), ...(closest.data?.verifiedTeam ?? [])]);
  const retry = () => { for (const read of Object.values(reads)) if (read.isError) void read.refetch(); };
  const retrying = Object.values(reads).some((read) => read.isError && read.isFetching);
  const states = COLUMNS.map((column) => {
    const read = reads[column.key];
    return { ...column, rows: rowsByColumn[column.key], metrics: read.data?.metrics, failed: read.isError || read.data?.section.state === "unavailable" };
  });
  // Keep the first-load skeleton. Once settled, the legacy catalog is available even if a live read fails.
  if (states.every((state) => state.rows === null && !state.failed)) return <TableCard className={styles.card}><BondingSkeleton /></TableCard>;
  return (
    <TableCard className={styles.card}>
      <div className={styles.switch}>
        <Segmented
          label="Curve stage"
          onChange={(stage) => {
            saveListContent(STAGE_HISTORY_KEY, stage);
            setShown(stage);
          }}
          options={COLUMNS.map(({ key, title }) => [key, title] as const)}
          size="sm"
          stretch
          wrap
          value={shown}
        />
      </div>
      <div className={styles.columns}>
        {states.map(({ key, title, none, rows, metrics, failed }) => {
          const heading = `${id}-${key}`;
          const renderLaunch = (row: DiscoveryRow) => <CurveRow column={key} key={row.launchId} metrics={metrics?.[row.launchId]} nowMs={nowMs} row={row} verified={row.verifiedTeam || (key !== "graduated" && verified.has(row.launchId))} />;
          const items = key === "graduated"
            ? graduatedColumnRows(rows, graduated.data).map((entry) => entry.kind === "launch"
              ? renderLaunch(entry.row)
              : <BondingCoinRow
                  coin={{ ...entry.coin, iconUrl: entry.coin.logoUrl }}
                  figures={<GraduatedFigures value={entry.value} />}
                  key={entry.coin.coinType}
                  rowKey={`home:bonding:${key}:${entry.coin.coinType}`}
                  verified={entry.coin.verifiedTeam}
                />)
            : rows?.map(renderLaunch);
          const skeletonCount = key === "graduated" ? BONDING_COLUMN_ROWS - BLAST_V1_COINS.length : BONDING_COLUMN_ROWS;
          return (
            <section aria-labelledby={heading} className={styles.column} data-shown={shown === key || undefined} key={key}>
              <h3 className={styles.head} id={heading}>{title}</h3>
              {rows === null && (failed
                ? <p className={styles.note} role="alert">Couldn’t load. <Button loading={retrying} loadingLabel="Retrying" onClick={retry} size="xs" type="button" variant="ghost">Retry</Button></p>
                : <ColumnSkeleton count={skeletonCount} title={title} />)}
              {items?.length === 0 ? <p className={styles.note}>{none}</p> : null}
              {items?.length ? (
                <ol aria-label={`${title} bonding curves`} className={styles.list}>
                  {items}
                </ol>
              ) : null}
            </section>
          );
        })}
      </div>
    </TableCard>
  );
}

function CurveRow({ column, row, metrics, nowMs, verified }: Readonly<{ column: BondingColumn; row: DiscoveryRow; metrics?: DiscoveryMetrics; nowMs: number; verified: boolean }>) {
  return <BondingCoinRow
    coin={row}
    detail={column === "new" ? <CurveAge nowMs={nowMs} row={row} /> : null}
    figures={<RowFigures column={column} metrics={metrics} nowMs={nowMs} row={row} />}
    rowKey={`home:bonding:${column}:${row.launchId}`}
    verified={verified}
  />;
}

function BondingCoinRow({ coin, detail, figures, rowKey, verified }: Readonly<{
  coin: Pick<DiscoveryRow, "coinType" | "symbol" | "name" | "iconUrl">;
  detail?: ReactNode;
  figures?: ReactNode;
  rowKey: string;
  verified?: boolean;
}>) {
  const legacy = blastV1Coin(coin.coinType);
  const symbol = legacy?.symbol ?? coin.symbol;
  const name = legacy?.name ?? coin.name;
  const ticker = symbol ? `$${symbol}` : name ?? shortCoinType(coin.coinType);
  return (
    <li data-list-row={rowKey}>
      <IntentLink className={styles.row} href={coinPagePath(coin.coinType)}>
        <span className={styles.identity}>
          <span className={styles.tile}>
            <CoinMark coin={{ key: coin.coinType, coinType: coin.coinType, symbol: symbol ?? undefined, iconUrl: legacy?.logoUrl ?? coin.iconUrl, round: false }} size={28} />
          </span>
          <span className={styles.text}>
            <strong className={clsx("coinNamed sm", styles.heading)}>
              <span className="ticker" title={!legacy && symbol && name && name !== symbol ? hoverExcerpt(name) : undefined}>{ticker}</span>
              <span className={styles.marks}>
                {verified ? <CoinVerifiedMark size="sm" /> : null}
                {legacy ? <CoinLegacyMark /> : null}
              </span>
            </strong>
            {legacy && name !== symbol ? <span className={clsx(styles.sub, styles.legacyName)}>{name}</span> : detail}
          </span>
        </span>
        {figures}
      </IntentLink>
    </li>
  );
}

/** How long ago a New curve launched: the one line under its ticker. */
function CurveAge({ row, nowMs }: Readonly<{ row: DiscoveryRow; nowMs: number }>) {
  const age = ago(row.createdAtMs, nowMs);
  return <span className={clsx("num", styles.sub)}><span className="sr">launched </span>{age === "now" ? "just now" : `${age} ago`}</span>;
}

/** The right side: progress and its bar on a curve; market cap and when it graduated once it trades in a pool. */
function RowFigures({ column, row, metrics, nowMs }: Readonly<{ column: BondingColumn; row: DiscoveryRow; metrics?: DiscoveryMetrics; nowMs: number }>) {
  if (column === "graduated") {
    return <GraduatedFigures
      value={metrics?.market?.market_cap_usd}
      age={row.graduatedAtMs === null ? undefined : ago(row.graduatedAtMs, nowMs)}
    />;
  }
  if (row.progressBps === null) return null;
  return (
    <span className={styles.figs}>
      <b className="num">{bpsPercent(row.progressBps)}<span className="sr"> to graduation</span></b>
      <progress aria-hidden="true" className={styles.bar} data-column={column} max={10_000} value={Math.min(row.progressBps, 10_000)} />
    </span>
  );
}

function GraduatedFigures({ value, age }: Readonly<{
  value?: string | null;
  age?: string;
}>) {
  if (value == null && age === undefined) return null;
  return (
    <span className={styles.figs}>
      {value != null ? <b className="num"><span className={styles.label}>Market cap </span>{readableUsd(value)}</b> : null}
      {age !== undefined ? <span className="num"><span className="sr">graduated </span>{age === "now" ? "just now" : `${age} ago`}</span> : null}
    </span>
  );
}

/** The first read: the switch (narrow), the three columns' heads and rows in place, with no tickers or figures yet. */
function BondingSkeleton() {
  return (
    <SkeletonRegion label="Loading bonding curves" listPending>
      <div aria-hidden="true" className={styles.switch}><SkeletonBox className={styles.switchBox} /></div>
      <div className={styles.columns}>
        {COLUMNS.map(({ key, title }) => (
          <div aria-hidden="true" className={styles.column} data-shown={key === "new" || undefined} key={key}>
            <b className={styles.head}>{title}</b>
            <SkeletonRowsBody />
          </div>
        ))}
      </div>
    </SkeletonRegion>
  );
}

function ColumnSkeleton({ count, title }: Readonly<{ count: number; title: string }>) {
  return <SkeletonRegion label={`Loading ${title}`}><SkeletonRowsBody count={count} /></SkeletonRegion>;
}

function SkeletonRowsBody({ count = BONDING_COLUMN_ROWS }: Readonly<{ count?: number }>) {
  return (
    <div aria-hidden="true" className={styles.list}>
      {Array.from({ length: count }, (_, index) => (
        <div className={styles.row} key={index}>
          <span className={styles.identity}>
            <SkeletonBox className={styles.tile} />
            <span className={styles.text}>
              <strong><SkeletonText>$TICK</SkeletonText></strong>
            </span>
          </span>
          <span className={styles.figs}><b><SkeletonText>00.0%</SkeletonText></b></span>
        </div>
      ))}
    </div>
  );
}
