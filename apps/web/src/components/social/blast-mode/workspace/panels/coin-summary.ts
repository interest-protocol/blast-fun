"use client";

import { pollInterval } from "#web/lib/query/polling.ts";
import { useQuery } from "@tanstack/react-query";

import { readCoinMarketSummary, type CoinSummary, type TradeWindow } from "@blast/core/modules/launchpad-contract/coin.ts";
import { coreCoin } from "@blast/core/modules/social/portfolio/core-coins.ts";
import { SUI_COIN_TYPE } from "@blast/core/lib/sui/coin-types.ts";
import { browserMarketDependencies } from "#web/components/launchpad/blast-infra-browser.ts";
import { coinDay, newerThanRead, useTradeFigures, type TradeFigures } from "#web/components/launchpad/trade-figures.ts";
import { gatedFetch } from "#web/lib/api-gate-client.ts";
import { useAppQueryClient } from "#web/lib/query/provider.tsx";
import { queryKeys } from "#web/lib/query/keys.ts";
import type { CoinAsset, CoinRecord } from "./coin-reads";

/**
 * The coin summary (`GET /v1/coins/<coin type>` through the market relay): the coin across its pools, with
 * its current pool's market, and the checkpoint it answers at. Null when the coin is no Blast launch on the
 * asset's network.
 */
export async function readCoinSummary(asset: CoinAsset): Promise<(CoinSummary & Readonly<{ checkpoint: number | null }>) | null> {
  const read = await readCoinMarketSummary(asset.coin_type, marketReads());
  if (read.status === "unavailable") throw new Error("The coin's market summary could not load.");
  return read.data.kind === "answer" && read.provenance.network === asset.network ? { ...read.data.value, checkpoint: read.provenance.checkpoint } : null;
}

/**
 * The one shared read of a coin's summary: the curve rail takes its current pool, the market facts its figures.
 * It never takes the query's abort signal: the market facts unmounting mid-read must not cancel the read the
 * curve rail has joined, and a finished read is cached either way.
 */
export function coinSummaryQuery(asset: CoinAsset) {
  return {
    queryKey: queryKeys.workspace.coinSummary(asset.network, asset.coin_type),
    queryFn: () => readCoinSummary(asset),
  };
}

/** The coin summary's figures for the panel's market facts, and when they were read. */
export type CoinSummaryFacts = Readonly<{
  /** The current pool's price × the coin's total supply, in USD; null without a USD price. */
  fdvUsd: string | null;
  holders: number;
  /** Buys and sells across the coin's pools over 24 h in USD; trades without a USD price are left out. */
  volume24hUsd: string | null;
  checkedAt: number;
}>;

export type CoinSummaryRead = ReturnType<typeof useCoinSummaryFacts>;

/**
 * The summary's figures for a coin the home feed gives no FDV or holder count: a Blast launch with no presale
 * (on its curve or migrated). One read when the panel
 * shows, then one every 30 s (the visible polling fallback); a coin that is no Blast launch is read once. Null
 * while the feed has both figures, before the first answer, or when the coin has no summary.
 */
export function useCoinSummaryFacts(asset: CoinAsset, coin: CoinRecord | null, visible: boolean) {
  const client = useAppQueryClient();
  const wanted = coin !== null && summaryCandidate(asset, coin);
  const read = useQuery(
    {
      ...coinSummaryQuery(asset),
      enabled: wanted && visible,
      refetchInterval: (query) => (query.state.data === null ? false : pollInterval(SUMMARY_POLL_MS, query)),
    },
    client,
  );
  const summary = wanted ? read.data : undefined;
  // Trades on the tab's market stream (the chart's) move the holders and volume between reads.
  const streamed = newerThanRead(useTradeFigures(summary ? asset.coin_type : null), summary?.checkpoint ?? null);
  const facts: CoinSummaryFacts | null = summary
    ? {
        fdvUsd: summary.market?.fdv_usd ?? null,
        holders: streamed?.holders ?? summary.stats.holders,
        volume24hUsd: dayVolumeUsd(summary, streamed),
        checkedAt: read.dataUpdatedAt,
      }
    : null;
  return {
    /** The first read is in flight. */
    loading: wanted && visible && read.isLoading,
    facts,
    refresh: () => (wanted && visible ? void read.refetch() : undefined),
  };
}

/** A mainnet coin outside any presale, not SUI or a curated ecosystem coin, whose feed record lacks FDV or holders. */
function summaryCandidate(asset: CoinAsset, coin: CoinRecord): boolean {
  return (
    asset.network === "mainnet" &&
    asset.presale_id === null &&
    !coin.presale_id &&
    asset.coin_type !== SUI_COIN_TYPE &&
    !coreCoin(asset.coin_type) &&
    (coin.fdv_usd == null || coin.holders == null)
  );
}

/** Trades in the day but no USD price on any of them: the summary's zero would read as no volume. */
function unpricedDay(day: TradeWindow): boolean {
  return day.trades > 0 && Number(day.volumeUsd) === 0;
}

/** The coin's 24 h USD volume; a trade's pool window stands for the coin's only while the coin trades on that one pool. */
function dayVolumeUsd(summary: CoinSummary, streamed: TradeFigures | null): string | null {
  const day = coinDay(streamed, summary.pools) ?? summary.stats.day;
  return unpricedDay(day) ? null : day.volumeUsd;
}

const SUMMARY_POLL_MS = 30_000;

/** The market relay's reads through the browser's request gate, cancelled with `signal` when one is given. */
export function marketReads(signal?: AbortSignal) {
  return browserMarketDependencies(null, (input, init) =>
    gatedFetch(input, { ...init, signal: AbortSignal.any([...(signal ? [signal] : []), ...(init?.signal ? [init.signal] : [])]) }),
  );
}
