"use client";

import type { CoinPage } from "@blast/core/modules/launchpad-coin/contracts.ts";

import type { ExpectedDeployment } from "@blast/core/modules/launchpad-contract/provenance.ts";
import { StreamedPrice } from "./StreamedPrice";
import { coinDay, newerThanRead, useTradeFigures } from "../trade-figures";

import { Glyph } from "../primitives/Glyph";
import styles from "./Coin.module.css";
import { formatQuantity, formatUsd } from "./coin-format";
import { coinIdentity, selectedPrice, sectionData } from "./coin-view";

function Stat({ term, children }: Readonly<{ term: string; children: React.ReactNode }>) {
  return (
    <div className={styles.stat}>
      <dt>{term}</dt>
      <dd>{children}</dd>
    </div>
  );
}

function PriceStat({ page, expected }: Readonly<{ page: CoinPage; expected?: ExpectedDeployment | null }>) {
  const identity = coinIdentity(page);
  const { price, known } = selectedPrice(page, 4);
  const unavailable = <span className={styles.missing}>Unavailable</span>;
  const economics = page.source.kind === "venue" ? sectionData(page.venue)?.economics : sectionData(page.curve)?.launch.economics;
  const checkpoint = (page.source.kind === "venue" ? page.venue : page.curve)?.provenance?.checkpoint ?? null;
  const fallbackPrice = price ?? (known ? <span className={styles.missing}>No price yet</span> : unavailable);
  const quoteDecimals = economics?.inputs.quoteDecimals ?? (identity.quoteDecimals === null ? null : BigInt(identity.quoteDecimals));
  const streamed = expected !== undefined && page.confirmed && page.source.poolKey !== null && economics && quoteDecimals !== null;
  return (
    <Stat term="Price">{streamed ? (
      <StreamedPrice key={`${page.source.poolKey}:${expected?.deployment ?? ""}`} poolKey={page.source.poolKey!} expected={expected} checkpoint={checkpoint} memeDecimals={Number(economics.inputs.memeDecimals)} quoteDecimals={Number(quoteDecimals)} quoteSymbol={identity.quoteSymbol} />
    ) : fallbackPrice}</Stat>
  );
}

/**
 * The coin's holders and 24 h window: the page's read, moved by trades on the chart's stream that are
 * newer than it (never behind it). Only a page tied to a deployment (`follow`) follows the stream.
 */
function useStreamedStats(page: CoinPage, follow: boolean) {
  const coin = sectionData(page.coin);
  const read = page.coin.state === "available" || page.coin.state === "stale" ? page.coin.provenance.checkpoint : null;
  const streamed = newerThanRead(useTradeFigures(coin && follow ? coin.coinType : null), read);
  return {
    holders: streamed?.holders ?? coin?.stats.holders,
    day: (coin ? coinDay(streamed, coin.pools) : null) ?? coin?.stats.day,
  };
}

/** The header's market facts. */
export function MarketStats(props: Readonly<{ page: CoinPage; expected?: ExpectedDeployment | null }>) {
  const { page } = props;
  const identity = coinIdentity(page);
  const coin = sectionData(page.coin);
  const unavailable = <span className={styles.missing}>Unavailable</span>;
  const { holders, day } = useStreamedStats(page, props.expected !== undefined);
  return (
    <dl className={styles.stats} aria-label="Market">
      <PriceStat page={page} expected={props.expected} />
      {coin?.market?.fdv_usd != null ? <Stat term="FDV">{formatUsd(coin.market.fdv_usd)}</Stat> : null}
      <Stat term="24h volume">
        {coin && day
          ? day.volumeUsd === null
            ? formatQuantity(day.volumeQuote, coin.quoteDecimals, identity.quoteSymbol)
            : formatUsd(day.volumeUsd)
          : unavailable}
      </Stat>
      <Stat term="Indexed holders">{coin && holders !== undefined ? holders.toLocaleString("en-US") : unavailable}</Stat>
    </dl>
  );
}

/** Whether the market facts shown are Stale or Unavailable, and when they are read again: on the page's own refresh. */
export function MarketState(props: Readonly<{ page: CoinPage }>) {
  const { page } = props;
  // The market facts come from the coin summary and, after migration, the venue pool.
  const marketState =
    [page.coin, ...(page.source.kind === "venue" && page.venue ? [page.venue] : [])].find(
      (section) => section.state === "stale" || section.state === "unavailable",
    ) ?? null;
  return (
    marketState ? (
      <p className={styles.marketState} role="status">
        <Glyph shape={marketState.state === "stale" ? "clock" : "slashed-ring"} />
        {marketState.state === "stale" ? "Price updates delayed." : "Market data couldn’t load. This page refreshes automatically."}
      </p>
    ) : null
  );
}
