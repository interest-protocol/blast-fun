import type { QueryClient } from "@tanstack/react-query";

import { parseLaunchSummary } from "@blast/core/modules/launchpad-contract/discovery.ts";
import { readV1 } from "@blast/core/modules/launchpad-contract/v1.ts";
import { SUI_COIN_TYPE } from "@blast/core/lib/sui/coin-types.ts";
import type { DiscoveryResponse } from "@blast/core/modules/launchpad-discovery/rows.ts";
import { queryKeys } from "#web/lib/query/keys.ts";
import { canonicalCoinType } from "../coin-row-model";
import type { CoinAsset, CoinRecord } from "./coin-reads";
import { coinSummaryQuery, marketReads } from "./coin-summary";

const CURVE_POOL = "blast_curve:";

/**
 * The launch whose bonding curve is the coin's current pool (`blast_curve:<launch id>`),
 * or null when the coin trades on another pool or is no Blast launch. It takes the coin
 * summary's shared read (the relay the coin page and the panel's chart use), fetched fresh
 * so a re-check after a trade sees a migration; a read already on its way is joined. Only this
 * query retries, so a failing relay is not asked retries × retries times. The
 * curve rail still reads the launch object from the node before anything is signed.
 */
export async function readCurveLaunch(client: QueryClient, asset: CoinAsset): Promise<string | null> {
  const pool = (await client.fetchQuery({ ...coinSummaryQuery(asset), staleTime: 0, retry: false }))?.currentPool;
  return pool?.startsWith(CURVE_POOL) ? pool.slice(CURVE_POOL.length) : null;
}

/** The launch id a loaded Bonding row already names for this coin, so a curve opened from Discover shows its rail at once. */
export function bondingLaunchId(client: QueryClient, coinType: string): string | undefined {
  const wanted = canonicalCoinType(coinType);
  if (wanted === null) return undefined;
  for (const query of client.getQueryCache().findAll({ queryKey: queryKeys.workspace.bonding })) {
    const section = (query.state.data as DiscoveryResponse | undefined)?.section;
    if (section?.state !== "available" && section?.state !== "stale") continue;
    const row = section.data.rows.find((item) => item.lifecycle !== "migrated" && canonicalCoinType(item.coinType) === wanted);
    if (row) return row.launchId;
  }
  return undefined;
}

/** Whether the coin may still trade on a Blast curve: a mainnet coin, not SUI, not a presale, not marked migrated. */
export function mayTradeOnCurve(asset: CoinAsset, coin: CoinRecord | null): boolean {
  return asset.network === "mainnet" && asset.presale_id === null && asset.coin_type !== SUI_COIN_TYPE && coin?.lifecycle !== "migrated";
}

/** The shared query for which curve, if any, the coin trades on: the trade section and the curve lists read the same answer. */
export function curveLaunchQuery(client: QueryClient, asset: CoinAsset) {
  return {
    queryKey: queryKeys.workspace.curveLaunch(asset.network, asset.coin_type),
    queryFn: () => readCurveLaunch(client, asset),
    placeholderData: () => bondingLaunchId(client, asset.coin_type),
  };
}

/**
 * A curve's quote coin and decimals, which never change for a launch, and its price now (quote atoms per meme atom,
 * null before the curve has one): one read of `GET /v1/pools/blast_curve/{launch id}`.
 */
export type CurvePool = Readonly<{ quoteType: string; quoteDecimals: number | null; memeDecimals: number; price: string | null }>;

export async function readCurvePool(launchId: string, signal: AbortSignal): Promise<CurvePool> {
  const read = await readV1(
    "market",
    `/v1/pools/blast_curve/${launchId}`,
    (body) => parseLaunchSummary((body as { pool?: unknown } | null)?.pool, "pool"),
    marketReads(signal),
  );
  signal.throwIfAborted();
  if (read.status === "unavailable" || read.data.kind !== "answer") throw new Error("The launch's curve could not load.");
  const launch = read.data.value;
  if (launch.launchId !== launchId) throw new Error("The curve read answered for another launch.");
  const { quoteDecimals, memeDecimals } = launch.economics.inputs;
  return {
    quoteType: launch.quoteType,
    quoteDecimals: quoteDecimals === null ? null : Number(quoteDecimals),
    memeDecimals: Number(memeDecimals),
    price: launch.economics.price,
  };
}

/** The shared curve read: the Trades list takes its units once, the header polls its price when the coin has no USD price. */
export function curvePoolQuery(launchId: string) {
  return {
    queryKey: queryKeys.workspace.curvePool(launchId),
    queryFn: ({ signal }: { signal: AbortSignal }) => readCurvePool(launchId, signal),
  };
}
