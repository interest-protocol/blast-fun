import { PRICE_WINDOW_MS, priceTierFor, PRICE_TIER_SPAN_MS, type PriceWindow, type PriceTier } from "@blast/core/modules/social/contracts/prices.ts";
import type { SocialPriceHistory } from "@blast/core/modules/social/contracts/prices.ts";
import type { HomeCoin } from "@blast/core/modules/social/contracts/home.ts";
import { fixtureCoinType } from "../social/trade/trade-fixtures.ts";

export const coinTypes = [fixtureCoinType("KSTL"), fixtureCoinType("LUMN")];
export const saleId = `0x${"1".repeat(64)}`;
export const coinRows = coinTypes.map((coin_type, index) => ({
  coin_type,
  symbol: index ? "LUMN" : "KSTL",
  name: index ? "Lumen" : "Kestrel",
  decimals: 9,
  icon_url: null,
  usd_price: index ? "0.0013" : "0.0021",
  price_usd: index ? "0.0013" : "0.0021",
  presale_id: index ? saleId : null,
  in_presale: false,
}));

export function history(
  coin_type: string,
  quoteOnly = false,
  count = 4,
): SocialPriceHistory {
  const points = Array.from(
    { length: count },
    (_, index) =>
      [
        1790337660000 + index * 60_000,
        quoteOnly
          ? "0.00000000000000000012345"
          : ["0.0021", "0.00212", "0.00208", "0.00211"][index % 4]!,
      ] as const,
  );
  return {
    coin_type,
    presale_id: coin_type === coinTypes[1] ? saleId : null,
    tier: "5m",
    from_ms: 1790337660000,
    points: quoteOnly ? [] : points,
    price_usd: quoteOnly ? null : "0.00211",
    price_24h_usd: null,
    change_24h_bps: null,
    day_open_usd: null,
    day_open_ms: null,
    ...(quoteOnly
      ? {
          quote: {
            coin_type: "0x2::sui::SUI",
            symbol: "SUI",
            price: "0.00000000000000000012345",
            as_of_ms: 1790337660000,
            points,
            change_24h_bps: null,
          },
        }
      : {}),
  };
}
export const holderSample = {
  share_bps: null,
  holders: Array.from({ length: 100 }, (_, index) => ({
    actor: {
      type: "address" as const,
      short: `Wallet ${index + 1}`,
      address: `0x${(index + 16).toString(16).padStart(64, "0")}`,
    },
    balance: index === 0 ? "18446744073709551615" : "123456789000000",
    share_bps: null,
  })),
};

/** Complete Home contract for the real discovery rail in the standalone fixtures. */
export const homeCoinRows: readonly HomeCoin[] = coinRows.map(({ coin_type, symbol, name, decimals, icon_url, presale_id, price_usd }) => ({
  coin_type, symbol, name, decimals, icon_url, presale_id, price_usd,
  lifecycle: "trading", venue: "cetus", tradable: true,
  opened_ms: null, launched_ms: 1790337660000, launch_id: null,
  quote: { type: "0x2::sui::SUI", symbol: "SUI", decimals: 9 }, sale: null,
  price_as_of_ms: 1790337660000, change_24h_bps: null,
  holders: null, holders_as_of_ms: null, fdv_usd: null, spark: [],
  activity: { scope: "pool", window: "24h", from_ms: 1790251260000, to_ms: 1790337660000, participants: 0, buyers: 0, sellers: 0, backers: 0, claimers: 0, events: 0, bought: [], sold: [], committed: [], latest_ms: null, preview: [] },
  discussion: { posts: 0 }, top_holders: { ...holderSample, holders: holderSample.holders.map(holder => ({ ...holder, actor: { ...holder.actor, short: `${holder.actor.address.slice(0, 6)}…${holder.actor.address.slice(-4)}` } })) },
  rank: { score: 0, why: "Controlled fixture: no recent activity" },
}));

/** Synthetic observations for visual QA only; never used by production price reads. */
export function denseChartHistory(coinType: string, window: PriceWindow, interval?: PriceTier): SocialPriceHistory {
  const end = Date.UTC(2026, 9, 26, 12);
  const span = window === "launch" ? 30 * 86_400_000 : PRICE_WINDOW_MS[window];
  const tier = interval ?? priceTierFor(span);
  const step = Math.max(PRICE_TIER_SPAN_MS[tier], span / 240);
  const count = Math.floor(span / step);
  const points = Array.from({ length: count + 1 }, (_, index) => {
    const atoms = Math.round(192000 + index * 45 + Math.sin(index * .22) * 3200 + Math.sin(index * 1.7) * 700 + Math.cos(index * .07) * 1800);
    return [end - span + index * step, (atoms / 100_000_000).toFixed(8)] as const;
  });
  return { ...history(coinType), tier, from_ms: end - span, points, price_usd: points.at(-1)![1] };
}
