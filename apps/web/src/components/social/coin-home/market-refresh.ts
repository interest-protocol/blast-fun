import { PublicError } from "#web/lib/errors.ts";
import { retryDelay, shouldRetry } from "#web/lib/query/client.ts";
import type { HomeCoin } from "@blast/core/web/contracts/home.ts";
import { homeCoinKey } from "./home-model";

export function retryMarketRead(attempt: number, error: Error): boolean {
  if (typeof document !== "undefined" && document.visibilityState === "hidden") return false;
  return attempt < 3 && (error instanceof PublicError && error.httpStatus === 429 || shouldRetry(attempt, error));
}

export function marketRetryDelay(attempt: number, error: Error): number {
  return Math.max(retryDelay(attempt), error instanceof PublicError ? (error.retryAfterSeconds ?? 0) * 1_000 : 0);
}

/** Keep the last observed market value, with its original timestamp, through partial failures. */
export function retainMarketValues<T extends Readonly<{ coins: readonly HomeCoin[] }>>(old: unknown, next: T): T {
  const previous = old && typeof old === "object" && "coins" in old && Array.isArray(old.coins) ? old.coins as HomeCoin[] : [];
  const byId = new Map(previous.map(coin => [homeCoinKey(coin), coin]));
  return { ...next, coins: next.coins.map(coin => {
    const before = byId.get(homeCoinKey(coin));
    if (coin.lifecycle !== "migrated" || coin.price_usd !== null || !before || before.coin_type !== coin.coin_type || before.price_as_of_ms === null) return coin;
    const retainedUntil = before.live_inputs?.open_24h_until_ms;
    const retainedCheckpoint = before.live_inputs?.price_checkpoint;
    const retained = { ...coin, price_usd: before.price_usd, price_as_of_ms: before.price_as_of_ms, fdv_usd: before.fdv_usd, change_24h_bps: before.change_24h_bps,
      ...(coin.live_inputs && {
        live_inputs: {
          total_supply: coin.live_inputs.total_supply,
          circulating_supply: coin.live_inputs.circulating_supply,
          open_1h_usd: coin.live_inputs.open_1h_usd,
          ...(retainedCheckpoint !== undefined && { price_checkpoint: retainedCheckpoint }),
          open_24h_usd: before.live_inputs?.open_24h_usd ?? null,
          ...(retainedUntil !== undefined && { open_24h_until_ms: retainedUntil }),
          baselines_until_ms: before.live_inputs?.baselines_until_ms ?? 0,
        },
      }),
      ...(coin.mobile_market && before.mobile_market ? {
        mobile_market: { ...coin.mobile_market, market_cap_usd: before.mobile_market.market_cap_usd },
      } : {}),
    };
    if (before.change_24h_from_ms === undefined) delete retained.change_24h_from_ms;
    else retained.change_24h_from_ms = before.change_24h_from_ms;
    return retained;
  }) };
}

export const marketReadPolicy = { retry: retryMarketRead, retryDelay: marketRetryDelay, gcTime: 30 * 60_000 };
