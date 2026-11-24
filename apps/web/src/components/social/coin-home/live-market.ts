import type { HomeCoin } from "@blast/core/web/contracts/home.ts";
import type { DisplayPrice } from "@blast/core/modules/launchpad-contract/market-stream.ts";
import { changeBps } from "@blast/core/modules/social/prices/change.ts";
import { fdvOf } from "@blast/core/modules/social/prices/valuation.ts";
import type { SparkPoint } from "#web/components/charts/spark-model.ts";

/** Revalue the public snapshot with its own supply and window inputs on each newer USD observation. */
export function coinAtPrice(coin: HomeCoin, price: DisplayPrice | undefined): HomeCoin {
  if (!price || price.as_of_ms < (coin.price_as_of_ms ?? 0)) return coin;
  const inputs = coin.live_inputs;
  const usd = price.usd_price;
  const hourIsCurrent = inputs && price.as_of_ms < inputs.baselines_until_ms;
  const dayIsCurrent = inputs && price.as_of_ms < (inputs.open_24h_until_ms ?? inputs.baselines_until_ms);
  return {
    ...coin,
    price_usd: usd,
    price_as_of_ms: price.as_of_ms,
    ...(inputs && {
      fdv_usd: fdvOf(usd, inputs.total_supply, coin.decimals),
      change_24h_bps: dayIsCurrent ? changeBps(usd, inputs.open_24h_usd) : coin.change_24h_bps,
      ...(coin.mobile_market && {
        mobile_market: {
          market_cap_usd: fdvOf(usd, inputs.circulating_supply, coin.decimals),
          change_1h_bps: hourIsCurrent ? changeBps(usd, inputs.open_1h_usd) : coin.mobile_market.change_1h_bps,
        },
      }),
    }),
  };
}

/** A fixed history plus its latest observed tip. Keep the historical time and price together. */
export function sparkAtPrice(history: readonly SparkPoint[] | null, at: number | null, usd: string | null, days: 1 | 7 = 7): readonly SparkPoint[] | null {
  const last = history?.at(-1);
  if (!history || !last || at === null || usd === null || at < last[0]) return history;
  const value = Number(usd);
  if (!Number.isFinite(value) || (at === last[0] && value === last[1])) return history;
  const start = at - days * 86_400_000;
  const points = history.filter(([time]) => time >= start && time < at);
  return [...points, [at, value]];
}
