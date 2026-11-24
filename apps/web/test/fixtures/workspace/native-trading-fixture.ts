import type { NativeCoinChart } from "../../../src/components/social/blast-mode/workspace/panels/coin-reads.ts";
import curve from "../../../../../packages/core/test/fixtures/modules/launchpad-contract/fixtures/v1-pool-candles-curve.json";

/** Recorded native candles; state overrides exercise presentation only. */
export function nativeTradingHistory(coinType: string, state: string): NativeCoinChart {
  const provenance = { source: "blast-infra" as const, network: "localnet" as const, deployment: null, checkpoint: 38, timestampMs: curve.provenance.timestamp_ms, observedAt: curve.provenance.timestamp_ms + 400, lagMs: 400 };
  const data = { poolKey: curve.migration.curve_pool_key, source: "curve" as const, venue: "blast_curve" as const, interval: "1m" as const, migration: null, candles: curve.candles.map(c => ({ bucketStart: c.bucket_start, open: c.open, high: c.high, low: c.low, close: c.close, volumeQuote: BigInt(c.volume_quote), volumeMeme: BigInt(c.volume_meme), volumeUsd: c.volume_usd, buys: c.buys, sells: c.sells, trades: c.trades })) };
  return { kind: "native", coin_type: coinType, source: { expected: null, curvePoolKey: data.poolKey, venuePoolKey: null, migration: null, symbol: "KSTL", quoteSymbol: "SUI", memeDecimals: 6, quoteDecimals: 9 }, chart: { venue: null, migration: null, curve: state === "native-empty" ? { state: "empty", provenance } : state === "native-unavailable" ? { state: "unavailable", reason: "fixture" } : state === "native-stale" ? { state: "stale", provenance, data, reason: "delayed" } : { state: "available", provenance, data } } };
}
