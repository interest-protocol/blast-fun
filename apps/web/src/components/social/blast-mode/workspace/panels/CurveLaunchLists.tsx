"use client";

import { pollInterval } from "#web/lib/query/polling.ts";
import { useQuery } from "@tanstack/react-query";

import { Button } from "#web/components/blast-ui/Button.tsx";
import { EmptyState } from "#web/components/blast-ui/EmptyState.tsx";
import { useLaunchpadEnabled } from "#web/components/blast-ui/launchpad-flag.tsx";
import { SkeletonText } from "#web/components/blast-ui/Skeleton.tsx";
import { POLL_MS } from "#web/components/launchpad/blast-infra-browser.ts";
import { CoinActivity } from "#web/components/launchpad/activity/CoinActivity.tsx";
import { shiftDecimal } from "#web/components/launchpad/coin/coin-format.ts";
import { typeSymbol } from "#web/components/launchpad/coin/coin-view.ts";
import { CoinHolders } from "#web/components/launchpad/holders/CoinHolders.tsx";
import { ThesesBoard } from "#web/components/launchpad/theses/ThesesBoard.tsx";
import { useAppQueryClient } from "#web/lib/query/provider.tsx";
import type { CoinAsset, CoinRecord } from "./coin-reads";
import { curveLaunchQuery, curvePoolQuery, mayTradeOnCurve } from "./curve-launch";

/**
 * The launch whose bonding curve the panel's coin trades on, or null. The home lists (Trades, Holders, Theses) key
 * on a presale, so a curve coin has none; these lists show the coin page's own launch reads instead. It is the
 * trade section's answer (one shared read), so a migrated coin hands back to the home lists with it. Each list
 * renders nothing while hidden: the coin page's lists re-read every 15 s while mounted. Undefined means the
 * answer is still pending.
 */
export function useCurveListLaunch(asset: CoinAsset, coin: CoinRecord | null, visible: boolean): string | null | undefined {
  const launchpad = useLaunchpadEnabled();
  const client = useAppQueryClient();
  const candidate = launchpad && mayTradeOnCurve(asset, coin);
  const read = useQuery({ ...curveLaunchQuery(client, asset), enabled: candidate && visible }, client);
  if (!candidate) return null;
  // Undefined while the first answer is on its way, so the header can wait for it instead of showing a dash;
  // a read paused offline counts as no answer.
  return read.data === undefined && !read.isError && read.fetchStatus !== "paused" ? undefined : (read.data ?? null);
}

/** The curve's price for one whole coin in its quote coin: an exact decimal, the quote's symbol, and when it was read. */
export type CurveQuotePrice = Readonly<{ price: string; symbol: string; checkedAt: number }>;

/**
 * The curve's price in its quote coin, for a curve coin with no USD price (its quote, such as Test SUI, is
 * unlisted). It shares the Trades list's curve read and re-reads it every 15 s, the coin read's pace, while
 * `enabled` (a minute apart after a failure). Undefined while the launch or the price is pending, null when
 * the coin has no curve, the read failed, or the curve has no price yet. A failed re-read keeps the last price.
 */
export function useCurveQuotePrice(launchId: string | null | undefined, enabled: boolean): CurveQuotePrice | null | undefined {
  const client = useAppQueryClient();
  const read = useQuery(
    {
      ...curvePoolQuery(launchId ?? ""),
      enabled: enabled && typeof launchId === "string",
      refetchInterval: (query) => pollInterval(query.state.status === "error" ? FAILED_POLL_MS : POLL_MS, query),
    },
    client,
  );
  if (!enabled || launchId === null) return null;
  const pool = read.data;
  if (launchId === undefined || pool === undefined) return read.isError ? null : undefined;
  if (pool.price === null || pool.quoteDecimals === null) return null;
  return { price: shiftDecimal(pool.price, pool.memeDecimals - pool.quoteDecimals), symbol: typeSymbol(pool.quoteType), checkedAt: read.dataUpdatedAt };
}

const FAILED_POLL_MS = POLL_MS * 4;

/**
 * The launch's trades on its curve, as the coin page lists them; the quote coin comes from one read of the curve.
 * `live` (the focused coin only) also shows the curve's trades from the tab's market stream before the next read;
 * compare cards keep their polls.
 */
export function CurveTrades({ launchId, asset, coin, visible, live = false }: Readonly<{ launchId: string; asset: CoinAsset; coin: CoinRecord | null; visible: boolean; live?: boolean }>) {
  return visible ? <ShownCurveTrades launchId={launchId} asset={asset} coin={coin} live={live} /> : null;
}

function ShownCurveTrades({ launchId, asset, coin, live }: Readonly<{ launchId: string; asset: CoinAsset; coin: CoinRecord | null; live: boolean }>) {
  const client = useAppQueryClient();
  const units = useQuery(
    {
      ...curvePoolQuery(launchId),
      // A launch's quote coin and decimals never change; the list reads no price.
      staleTime: Infinity,
    },
    client,
  );
  // A failed price re-read (the header polls this read) keeps the units it already has.
  if (!units.data && units.isError) {
    return <EmptyState compact role="alert" title="Trades could not load" action={<Button variant="secondary" size="sm" type="button" onClick={() => void units.refetch()}>Retry trades</Button>} />;
  }
  if (!units.data) return <span role="status" aria-label="Loading trades"><SkeletonText>Trader, side and amount</SkeletonText></span>;
  return (
    <CoinActivity
      compact
      source={{
        launchId,
        expected: null,
        explorer: null,
        anchor: null,
        livePools: live ? [`blast_curve:${launchId}`] : undefined,
        units: {
          symbol: coin?.symbol ?? typeSymbol(asset.coin_type),
          memeDecimals: coin?.decimals ?? units.data.memeDecimals,
          quoteSymbol: typeSymbol(units.data.quoteType),
          quoteDecimals: units.data.quoteDecimals,
        },
      }}
    />
  );
}

/** The coin's holder snapshot, as the coin page shows it (no PnL or entry: those need a presale). */
export function CurveHolders({ launchId, asset, coin, visible }: Readonly<{ launchId: string; asset: CoinAsset; coin: CoinRecord | null; visible: boolean }>) {
  if (!visible) return null;
  return (
    <CoinHolders
      compact
      source={{ launchId, coinType: asset.coin_type, expected: null, symbol: coin?.symbol ?? typeSymbol(asset.coin_type), decimals: coin?.decimals ?? null }}
    />
  );
}

/** The launch's public theses, read only, as Blast mode's Theses are; posting stays on the coin page. */
export function CurveTheses({ launchId, coin, visible }: Readonly<{ launchId: string; coin: CoinRecord | null; visible: boolean }>) {
  if (!visible) return null;
  return <ThesesBoard launchId={launchId} symbol={coin?.symbol ?? null} composer={noComposer} />;
}

const noComposer = () => null;
