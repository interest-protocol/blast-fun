// Committed vault discovery and venue market references from blast-infra.
import type { Pool } from "pg";
import { z } from "zod";
import { autocommitRead } from "@blast/core/modules/database/transaction.ts";
import { readV1 } from "@blast/core/modules/launchpad-contract/v1.ts";
import { readPoolCandles } from "@blast/core/modules/launchpad-contract/venue-history.ts";
import type { RoutedRead } from "@blast/core/modules/launchpad-contract/read.ts";
import type { MarketDataDependencies } from "@blast/core/modules/read-routing/market-data.ts";
import { twapPrice, type BuybackFacts, type QuoteUsd } from "./pricing.ts";
import type { BuybackVenue, DiscoveredVault } from "./repository.ts";

function fresh<T>(read: RoutedRead<T>, maxLagMs: number): boolean {
  return read.status === "fresh" && read.provenance.lagMs !== null && read.provenance.lagMs <= maxLagMs;
}

type VaultRow = {
  vault_id:string; origin_id:string; package_witness:string; venue_type:string;
  meme_type:string; quote_type:string; venue:BuybackVenue; pool_id:string;
  tick_spacing:number; fee_rate:string|null;
};
/** Both products share one committed vault view. A foreign or stale watermark yields no candidates. */
export async function discoverVaults(pool: Pool, network: string, fingerprint: string, maxLagMs: number, maxPages: number): Promise<Readonly<{vaults:DiscoveredVault[];complete:boolean}>> {
  const vaults: DiscoveredVault[] = [];
  let cursor = "";
  for (let page=0;page<maxPages;page+=1) {
    const {rows}=await autocommitRead<VaultRow>(pool,"vault-buyback",
      `SELECT v.vault_id,v.origin_id,v.package_witness,v.venue_type,v.meme_type,v.quote_type,v.venue,v.pool_id,
              t.tick_spacing,t.fee_rate::text
       FROM chain_read_v1.vaults v
       JOIN chain_read_v1.pool_tiers t ON t.meme_type=v.meme_type AND t.quote_type=v.quote_type AND t.venue=v.venue
       JOIN chain_read_v1.watermark w ON w.network=$1 AND w.deployment_fingerprint=$2
       WHERE w.checkpoint IS NOT NULL AND w.lag_ms <= $3 AND v.vault_id > $4
         AND NOT EXISTS (SELECT 1 FROM mission_control_vault_buybacks b WHERE b.network=$1 AND b.vault_id=v.vault_id)
       ORDER BY v.vault_id LIMIT 100`,[network,fingerprint,maxLagMs,cursor]);
    for (const row of rows) vaults.push({vaultId:row.vault_id,originId:row.origin_id,packageWitness:row.package_witness,
      venueType:row.venue_type,memeType:row.meme_type,quoteType:row.quote_type,venue:row.venue,poolId:row.pool_id,
      poolTickSpacing:Number(row.tick_spacing),poolFeeRate:row.fee_rate===null?null:BigInt(row.fee_rate)});
    if(rows.length<100) return {vaults,complete:true};
    cursor=rows.at(-1)!.vault_id;
  }
  return {vaults,complete:false};
}

/**
 * The pool's time-weighted price over the last `windowMs` of chain time (the
 * answer's committed checkpoint), from its own 1m candles: `stale` when
 * blast-infra lags beyond `maxLagMs`, `unavailable` when it cannot answer or
 * the pool has no candle.
 */
export async function readReference(
  venue: BuybackVenue,
  poolId: string,
  windowMs: number,
  maxLagMs: number,
  dependencies: MarketDataDependencies,
): Promise<BuybackFacts["reference"]> {
  const read = await readPoolCandles(`${venue}:${poolId}`, { interval: "1m", limit: windowMs / 60_000 + 2 }, dependencies);
  if (read.status === "unavailable" || read.data.kind !== "answer") return { status: "unavailable" };
  if (!fresh(read, maxLagMs) || read.provenance.timestampMs === null) return { status: "stale" };
  const end = read.provenance.timestampMs;
  const candles = read.data.value.candles;
  // A full page that starts inside the window cannot say what the price was at its start.
  if (candles.length === windowMs / 60_000 + 2 && (candles[0]?.bucketStart ?? end) > end - windowMs) return { status: "unavailable" };
  const price = twapPrice(candles, end - windowMs, end);
  return price === null || price <= 0n ? { status: "unavailable" } : { status: "fresh", price };
}

const quoteUsdSchema = z.object({
  pool: z.object({
    pool_id: z.string(),
    inputs: z.looseObject({ quote_decimals: z.string().regex(/^[0-9]{1,2}$/).nullable() }),
    quote_usd: z
      .object({ price: z.string().regex(/^[1-9][0-9]{0,30}$/), expo: z.number().int().min(-30).max(30), age_ms: z.number().int().nonnegative() })
      .nullable()
      .optional(),
  }),
});

/** The Quote's USD price from the venue pool's summary, or null when absent, older than `maxAgeMs`, or not fresh. */
export async function readQuoteUsd(
  venue: BuybackVenue,
  poolId: string,
  maxAgeMs: number,
  maxLagMs: number,
  dependencies: MarketDataDependencies,
): Promise<QuoteUsd | null> {
  const read = await readV1(
    "market",
    `/v1/pools/${venue}/${poolId}`,
    (body) => {
      const parsed = quoteUsdSchema.safeParse(body);
      if (!parsed.success || parsed.data.pool.pool_id !== poolId) return null;
      const { quote_usd: usd, inputs } = parsed.data.pool;
      if (!usd || inputs.quote_decimals === null || usd.age_ms > maxAgeMs) return null;
      return { price: BigInt(usd.price), expo: usd.expo, decimals: Number(inputs.quote_decimals) };
    },
    dependencies,
  );
  if (read.status === "unavailable" || !fresh(read, maxLagMs) || read.data.kind !== "answer") return null;
  return read.data.value;
}
