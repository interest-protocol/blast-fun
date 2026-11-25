import type { HomeCoin, HomeCoinsPage } from "@blast/core/modules/social/contracts/home.ts";

/** Coins-table rows for `/home-tabs-proof`: every Status form, unknown figures, and worst-case names and numbers. */
export const NOW = Date.UTC(2026, 10, 25, 12);
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const SUI = { type: "0x2::sui::SUI", symbol: "SUI", decimals: 9 } as const;
const USDC = { type: "0xdba3::usdc::USDC", symbol: "USDC", decimals: 6 } as const;

const base: HomeCoin = {
  presale_id: null, coin_type: "0x1::fixture::TEST", symbol: "TEST", name: "Fixture", icon_url: null, decimals: 9,
  lifecycle: "migrated", venue: "cetus", tradable: true, opened_ms: null, launched_ms: null, launch_id: null,
  quote: SUI, sale: null, price_usd: null, price_as_of_ms: NOW - 30_000, change_24h_bps: null, holders: null,
  holders_as_of_ms: null, fdv_usd: null, spark: [], curve: null,
  activity: { scope: "pool", window: "24h", from_ms: NOW - DAY, to_ms: NOW, participants: 0, events: 0,
    buyers: 0, sellers: 0, backers: 0, claimers: 0, bought: [], sold: [], committed: [], latest_ms: null, preview: [] },
  top_holders: { holders: [], share_bps: null }, discussion: { posts: 0 }, rank: { score: 0, why: "Controlled fixture" },
};

function coin(n: number, symbol: string, name: string, extra: Partial<HomeCoin>): HomeCoin {
  return { ...base, coin_type: `${id(n)}::${symbol.toLowerCase().replace(/\W/g, "x") || "c"}::COIN`, symbol, name, ...extra };
}
const volume = (usd: string) => ({ usd, usd_complete: true, venues: { cetus: { usd, usd_complete: true }, bluefin: { usd: "0", usd_complete: true } } });
const market = (cap: string | null, change: number | null) => ({ market_cap_usd: cap === null ? null : `${cap}.00`, change_1h_bps: change });
const id = (n: number) => `0x${n.toString(16).padStart(64, "0")}`;
const curve = (lifecycle: NonNullable<HomeCoin["curve"]>["lifecycle"], progress_bps: number | null, quote_remaining: string | null) =>
  ({ launch_id: id(0x1a),  lifecycle: "open" as const, venue: "blast_curve", tradable: false, curve: { lifecycle, progress_bps, quote_remaining } });

export const POPULATED: readonly HomeCoin[] = [
  coin(1, "KSTL", "Kestrel", { ...curve("live", 7250, "310000000000"), price_usd: "0.0021", change_24h_bps: 1840, holders: 412, mobile_market: market("21000", 300), dex_volume: volume("8400") }),
  coin(2, "MOTH", "Night Moth", { ...curve("live", 9410, "52000000"), quote: USDC, price_usd: "0.0040", change_24h_bps: -420, holders: 1290, mobile_market: market("40000", null), dex_volume: volume("31000") }),
  coin(3, "FERN", "Fern", { ...curve("migration_ready", 10_000, "0"), price_usd: "0.0052", change_24h_bps: 0, holders: 2004, mobile_market: market("52000", 0), dex_volume: volume("51000") }),
  coin(4, "ORCA", "Orca Pod", { ...curve("migrated", 10_000, "0"), lifecycle: "migrated", venue: "cetus", tradable: true, graduated_ms: NOW - 3 * DAY, price_usd: "0.091", change_24h_bps: 2210, holders: 5120, mobile_market: market("910000", 120), dex_volume: volume("204000") }),
  coin(5, "LUMA", "Luma Labs", { presale_id: id(0x5a1), launched_ms: NOW - 3 * DAY, price_usd: "0.31", change_24h_bps: -1290, holders: 880, mobile_market: market("3100000", -50), dex_volume: volume("96000") }),
  coin(6, "TIDE", "Tide", { presale_id: id(0x5a2), lifecycle: "open", tradable: false, venue: "cetus", sale: { start_ms: NOW - DAY, end_ms: NOW + 3 * HOUR, raise_target: "1000000000000", raised: "420000000000", participants: 61 } }),
  coin(7, "SUI", "Sui", { venue: "bluefin", price_usd: "3.42", change_24h_bps: 310, holders: null, mobile_market: market("11200000000", 40), dex_volume: volume("48000000") }),
  coin(8, "NEW", "New coin", { ...curve("opening_round", null, null) }),
];

export const WORST: readonly HomeCoin[] = [
  coin(11, "WrappedStakedInstitutionalSUI", "Wrapped Staked Institutional Sui Treasury", { ...curve("live", 9999, "999999999999999999"), price_usd: "0.0000000000168", change_24h_bps: 9_999_999, holders: 12_345_678, mobile_market: market("999999999999999", 99999), dex_volume: volume("999999999999") }),
  coin(12, "社区共建生态基金", "社区共建生态基金 · Nguyễn Thị Minh", { ...curve("migrated", 10_000, "0"), lifecycle: "migrated", venue: "bluefin", tradable: true, graduated_ms: NOW - 400 * DAY, price_usd: "12345.678901", change_24h_bps: -9999, holders: 1, mobile_market: market("0", -9999), dex_volume: volume("0") }),
  coin(13, "J", "Jo", { presale_id: id(0x5a3), lifecycle: "open", tradable: false, venue: "cetus", sale: { start_ms: NOW + 39 * 60_000, end_ms: NOW + 30 * DAY, raise_target: "1000000000000", raised: "0", participants: 0 } }),
  coin(14, "🚀MOON", "Moon & Stars <Community>", { venue: "an_unlisted_exchange_with_a_long_name" }),
  coin(15, "BRIDGE_USDC", "Bridged USD Coin (Wormhole Portal)", { presale_id: id(0x5a4), launched_ms: null, price_usd: "1", holders: 999_999_999, mobile_market: market(null, null) }),
];

export function page(coins: readonly HomeCoin[]): HomeCoinsPage {
  return { coins: [...coins], next_cursor: null, window: "24h", clock_ms: NOW, as_of: { checkpoint: 1, timestamp_ms: NOW, lag_ms: 0 }, page: 1, pages: 1, total: coins.length };
}

