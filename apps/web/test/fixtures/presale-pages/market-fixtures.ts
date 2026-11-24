import type {
  HomeCoin,
  HomeHolder,
} from "@blast/core/modules/social/contracts/home.ts";
import { FIXTURE_NOW, fixtureDetail } from "../../../../../packages/core/test/fixtures/presale-pages/presale-fixtures.ts";

export function fixtureMarket(holders = 100): HomeCoin {
  const sale = fixtureDetail("kstl").presale;
  const rows: HomeHolder[] = Array.from({ length: holders }, (_, index) => ({
    actor:
      index % 2 === 0
        ? {
            type: "account",
            callsign: `holder${index + 1}`,
            display_name: `Holder ${index + 1}`,
            avatar_url: null,
            x_handle: null,
            verified: false,
            path: `/@holder${index + 1}`,
          }
        : {
            type: "address",
            address: `0x${(index + 1).toString(16).padStart(64, "0")}`,
            short: `0x0000…${(index + 1).toString(16).padStart(4, "0")}`,
          },
    balance: (BigInt(holders - index) * 1_000_000_000n).toString(),
    share_bps: holders - index,
  }));
  return {
    presale_id: sale.presale_id,
    coin_type: sale.sale_token,
    symbol: sale.symbol,
    name: sale.name,
    icon_url: null,
    decimals: 9,
    lifecycle: "migrated",
    venue: "bluefin",
    tradable: true,
    opened_ms: FIXTURE_NOW - 172_800_000,
    launched_ms: FIXTURE_NOW - 86_400_000,
    launch_id: null,
    quote: {
      type: sale.quote_type,
      symbol: sale.quote_symbol,
      decimals: sale.quote_decimals,
    },
    sale: null,
    price_usd: null,
    price_as_of_ms: null,
    change_24h_bps: null,
    holders: holders + 2,
    holders_as_of_ms: FIXTURE_NOW,
    fdv_usd: null,
    spark: [],
    activity: {
      scope: "pool",
      window: "24h",
      from_ms: FIXTURE_NOW - 86_400_000,
      to_ms: FIXTURE_NOW,
      participants: 0,
      events: 0,
      buyers: 0,
      sellers: 0,
      backers: 0,
      claimers: 0,
      bought: [],
      sold: [],
      committed: [],
      latest_ms: null,
      preview: [],
    },
    discussion: { posts: 0 },
    top_holders: { holders: rows, share_bps: null },
    rank: { score: 0, why: "No recent activity" },
  };
}
