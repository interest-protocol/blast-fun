/**
 * Sample data for the parity-gaps proof page (`/parity-proof`, #589's reads
 * wired in the web app). Every person, coin, sale and amount here is
 * invented for visual review: the shapes are the production contracts, the
 * values are not market data. Times are relative to a shared fixture clock, so a
 * scheduled sale is always ahead and an open one always closing later.
 */
import type { FeedItemActor } from "@blast/core/modules/social/contracts/items.ts";
import type { HomeHolderPosition, HomeHoldersPage } from "@blast/core/modules/social/contracts/coin-market.ts";
import type { HomeCoin, HomeCoinsByIds } from "@blast/core/modules/social/contracts/home.ts";
import type { SocialHappeningResponse } from "@blast/core/modules/social/contracts/happening.ts";
import type { SocialPriceHistory, SocialPricesResponse } from "@blast/core/modules/social/contracts/prices.ts";
import type { PresaleStatusCounts, SocialPresaleDetail, SocialPresaleListPage } from "@blast/core/modules/social/contracts/presales.ts";
import type { SocialProfileCalls, ProfileCall } from "@blast/core/modules/social/contracts/profile-page.ts";
import type { ReferralInvitee } from "@blast/core/modules/social/referrals/contracts.ts";
import type { ShellViewer } from "../../../src/components/blast-ui/shell-viewer.ts";
import type { PortfolioSummaryState } from "../../../src/components/blast-ui/portfolio.ts";
import type { Competition, CompetitionViewerRank } from "@blast/core/modules/social/competitions/contracts.ts";
import type { SocialPortfolio } from "@blast/core/modules/social/contracts/portfolio.ts";
import { NO_COST_BASIS } from "@blast/core/modules/social/contracts/portfolio.ts";
import type { WatchlistRow } from "../../../src/components/social/watchlist/watchlist-model.ts";
import type { HoldingCoin } from "../../../src/components/social/profile/profile-model.ts";
import { happeningPresale, happeningRead } from "../social/happening/happening-fixtures.ts";
import { FIXTURE_NOW, fixtureDetail, fixtureList } from "../../../../../packages/core/test/fixtures/presale-pages/presale-fixtures.ts";
import { account, proofCoinTypes, proofHomeCoins, sampleIcons, wallet } from "./redesign-fixtures";

export const NOW = Date.parse("2026-11-09T14:00:00Z");
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const hex = (seed: number) => `0x${seed.toString(16).padStart(64, "0")}`;
const asOf = { checkpoint: 1, timestamp_ms: NOW - 20_000, lag_ms: 20_000 };
const mark = (fill: string, glyph: string) => `data:image/svg+xml;utf8,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48"><rect width="48" height="48" fill="${fill}"/><text x="24" y="31" font-family="sans-serif" font-size="20" font-weight="700" fill="#fff" text-anchor="middle">${glyph}</text></svg>`)}`;

/* ---------- Blast mode Holders (HolderPositions): a mix with and without a thesis ---------- */

const position = (actor: FeedItemActor, balance: string, value: string | null, entry: string | null, pnl: string | null, why: string | null): HomeHolderPosition => ({
  actor, balance, share_bps: 120, value_usd: value, average_entry_usd: entry,
  basis_usd: pnl === null || value === null ? null : (Number(value) - Number(pnl)).toFixed(2), basis_complete: pnl !== null, pnl_usd: pnl,
  pnl_multiple: pnl === null || value === null ? null : (Number(value) / (Number(value) - Number(pnl))).toFixed(4), why,
});
export const HOLDERS: HomeHoldersPage = {
  coin_type: proofCoinTypes.KSTL, presale_id: null, decimals: 9, price_usd: "0.002140", price_as_of_ms: NOW,
  as_of: asOf,
  holders: [
    position(account("ines"), "5785000000000000", "12380.00", "0.001410", "4210.00", "Storage demand from AI agents is only starting"),
    position(account("mara"), "2890000000000000", "6184.00", "0.001880", "751.00", null),
    position(wallet(1), "2100000000000000", null, null, null, null),
    position(account("juno"), "1560000000000000", "3338.00", "0.002460", "-484.00", "Mainnet usage keeps climbing and the float is thin"),
    position(account("devon"), "990000000000000", "2118.00", "0.001120", "960.00", "Cheapest way into the Cetus pool"),
    position(account("kofi"), "640000000000000", "1369.00", "0.002010", "84.00", null),
    position(wallet(2), "410000000000000", null, null, null, null),
  ],
};

/* ---------- Home, Blast mode rows: a sale open on chain whose start is still ahead, beside a live one ---------- */

const [kstl, mochi, lumn, , , , nova] = proofHomeCoins as readonly HomeCoin[];
const HALO_START = NOW + 5 * HOUR + 20 * MINUTE;
/** On chain `open` from its share, but `start_ms` is ahead: every surface must read it as upcoming (#588). */
export const SCHEDULED: HomeCoin = {
  ...nova!,
  presale_id: hex(0x5c4ed),
  coin_type: `0x${"e5".repeat(32)}::halo::HALO`,
  symbol: "HALO", name: "Halo", icon_url: mark("#3f7bd8", "H"),
  lifecycle: "open", tradable: false,
  sale: { start_ms: HALO_START, end_ms: HALO_START + 3 * DAY, raise_target: "50000000000", raised: "0", participants: 0 },
  activity: { ...nova!.activity, participants: 0, buyers: 0, backers: 0, events: 0, preview: [] },
  rank: { score: 92, why: "Opens later today" },
};
/** A normal open sale: started yesterday, closes in about four hours. */
export const OPEN_SALE: HomeCoin = {
  ...nova!,
  sale: { ...nova!.sale!, start_ms: NOW - DAY, end_ms: NOW + 4 * HOUR + 20 * MINUTE },
};
export const HOME_COINS: readonly HomeCoin[] = [kstl!, SCHEDULED, OPEN_SALE, mochi!, lumn!];

const happeningOf = (coin: HomeCoin) => happeningPresale({
  presale_id: coin.presale_id!, symbol: coin.symbol, name: coin.name, icon_url: coin.icon_url ?? "", lifecycle: "open",
  start_ms: coin.sale!.start_ms, end_ms: coin.sale!.end_ms, raise_target: coin.sale!.raise_target, raised: coin.sale!.raised,
  participants: coin.sale!.participants,
});
export const HAPPENING: SocialHappeningResponse = happeningRead({
  clock_ms: NOW, as_of: asOf, tape: [], last_hour: { wallets: 0, usd: "0.00" },
  today: [happeningOf(SCHEDULED), happeningOf(OPEN_SALE)], fastest: [happeningOf(OPEN_SALE)], opening_soon: [],
});
export const SALE_COINS: HomeCoinsByIds = { coins: [SCHEDULED, OPEN_SALE], missing: [], window: "24h", clock_ms: NOW, as_of: asOf };
export const homeCoinsByIds = (ids: readonly string[]): HomeCoinsByIds => ({ ...SALE_COINS, coins: HOME_COINS.filter((coin) => ids.length === 0 || ids.includes(coin.presale_id ?? "")) });

/* ---------- Watchlist: trading coins up, down and without a 24 h change; an open and a pending sale ---------- */

const watchRow = (n: number, symbol: string, name: string, extra: Partial<WatchlistRow>): WatchlistRow => ({
  presale_id: hex(0xa7c00 + n), name, symbol, icon_url: mark(["#e2558f", "#2f9e6e", "#7c5cff", "#d98a1c", "#3f7bd8"][n % 5]!, symbol[0]!),
  phase: "trading", start_ms: NOW - 20 * DAY, end_ms: NOW - 16 * DAY, fill_pct: 100, multiple: 4.2, price_usd: null, ...extra,
});
export const WATCHLIST: readonly WatchlistRow[] = [
  watchRow(1, "CETUS", "Cetus", { price_usd: "0.0951", multiple: 4.2 }),
  watchRow(2, "NAVX", "Navi", { price_usd: "0.0412", multiple: 0.8 }),
  watchRow(3, "QUIET", "Quiet", { price_usd: "0.5", multiple: 1.1 }),
  watchRow(4, "MRDN", "Meridian", { phase: "open", start_ms: NOW - DAY, end_ms: NOW + 6 * HOUR + 12 * MINUTE, fill_pct: 73, multiple: null }),
  watchRow(5, "SABL", "Sable", { phase: "pending", start_ms: NOW + 2 * DAY + 3 * HOUR, end_ms: NOW + 5 * DAY, fill_pct: 0, multiple: null }),
];
/** Each coin row's 24 h change in basis points; QUIET's read has none. */
const CHANGES: Readonly<Record<string, number | null>> = { [WATCHLIST[0]!.presale_id]: 571, [WATCHLIST[1]!.presale_id]: -305, [WATCHLIST[2]!.presale_id]: null };
export function pricesFor(ids: readonly string[]): SocialPricesResponse {
  const prices = ids.flatMap((id): SocialPriceHistory[] => {
    if (!(id in CHANGES)) return [];
    const row = WATCHLIST.find((entry) => entry.presale_id === id)!;
    return [{ presale_id: id, coin_type: `0x${id.slice(-6)}::c::${row.symbol}`, tier: "5m", from_ms: NOW - DAY, points: [], price_usd: row.price_usd!, price_24h_usd: null, change_24h_bps: CHANGES[id]!, day_open_usd: null, day_open_ms: null }];
  });
  return { window: "24h", clock_ms: NOW, prices, as_of: asOf };
}

/* ---------- Create's Raise: Opens empty, valid, already past, too far ahead ---------- */

const nextQuarter = (ms: number) => Math.ceil(ms / (15 * MINUTE)) * 15 * MINUTE;
export const OPENS: Readonly<Record<string, number | null>> = {
  empty: null,
  valid: nextQuarter(NOW + 2 * DAY),
  past: nextQuarter(NOW - 3 * HOUR),
  far: nextQuarter(NOW + 120 * DAY),
};

/* ---------- Sale Terms: a Cetus sale's 0.25% pool fee; an Aftermath sale with none ---------- */

export function termsDetail(venue: string): SocialPresaleDetail {
  const detail = fixtureDetail("mrdn");
  if (venue === "aftermath") return { ...detail, presale: { ...detail.presale, venue: "aftermath" }, terms: { ...detail.terms!, trading_fee_ppm: null } };
  return { ...detail, terms: { ...detail.terms!, trading_fee_ppm: 2_500 } };
}

/* ---------- Presales list: the selected tab's count from the read's status_counts ---------- */

/** The prototype list's sales, moved from its frozen clock to now, so "live" stays live. */
function shifted<T>(value: T, delta: number): T {
  if (Array.isArray(value)) return value.map((entry) => shifted(entry, delta)) as T;
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, typeof entry === "number" && key.endsWith("_ms") && entry > 1e12 ? entry + delta : shifted(entry, delta)])) as T;
}
export const STATUS_COUNTS: PresaleStatusCounts = { live: 6, upcoming: 1_204, ended: 37 };
export function presalesPage(status: "live" | "upcoming" | "ended"): SocialPresaleListPage {
  return { ...shifted(fixtureList(status, status === "upcoming" ? "opening" : "ending"), NOW - FIXTURE_NOW), status_counts: STATUS_COUNTS };
}

/* ---------- The shell: a signed-in viewer (`?shell=member`) ---------- */

export const SHELL_VIEWER: ShellViewer = { accountId: "00000000-0000-4000-8000-0000000000a1", callsign: "kaimoreno", displayName: "Kai Moreno", avatarUrl: null, verified: true };
export const SHELL_PORTFOLIO: PortfolioSummaryState = { status: "ready", summary: { total_usd: 4_760.34, today: { usd: 224.81, pct: 4.96 } } };
/** The trading coin's page (Kestrel) for its right column: the ticket, then Tokenomics. */
export const tradingDetail = (): SocialPresaleDetail => fixtureDetail("kstl");

/* ---------- Profile Calls: with and without a thesis line ---------- */

const call = (n: number, symbol: string, name: string, entry: string, price: string, multiple: string, why: string | null): ProfileCall => ({
  presale: {
    presale_id: hex(0xca110 + n), name, symbol, icon_url: mark(["#e2558f", "#2f9e6e", "#7c5cff", "#d98a1c"][n % 4]!, symbol[0]!), status: "trading", venue: "cetus",
    start_ms: NOW - 30 * DAY, end_ms: NOW - 26 * DAY, fill_pct: 100, quote_symbol: "USDC", quote_decimals: 6, launched_ms: NOW - 24 * DAY, first_unlock_ms: null,
  },
  committed_usd: "100.00", committed_atoms: "100000000", entry_price_usd: entry, price_usd: price, multiple, value_usd: null, pnl_usd: null,
  last_commit_ms: NOW - 27 * DAY, series: null, why,
});
export const CALLS: SocialProfileCalls = {
  calls: [
    call(1, "WAL", "Walrus", "0.31", "0.4127", "1.3313", "Walrus storage demand keeps climbing"),
    call(2, "NS", "SuiNS", "0.12", "0.0981", "0.8175", null),
    call(3, "DEEP", "DeepBook", "0.021", "0.0544", "2.5905", "Every perp venue on Sui will route through the book, and the float is a fraction of what the market thinks it is"),
    call(4, "OLD", "Oldtown", "0.0088", "0.0091", "1.0341", null),
    // A subscript-zero entry (#595): the whole price stays on the call line at 320px.
    call(5, "MOCHI", "Mochi", "0.0000641", "0.0000702", "1.0952", "Meme volume follows the cheapest liquid ticker"),
  ],
  track_record: { presales_backed: 5, launched: 5, pnl_usd: null },
  as_of: asOf,
};

/* ---------- Invites: "Joined <day>", with and without a profile ---------- */

const noon = (daysAgo: number) => { const at = new Date(NOW - daysAgo * DAY); at.setHours(12, 0, 0, 0); return at.getTime(); };
export const INVITEES: readonly ReferralInvitee[] = [
  { id: "00000000-0000-4000-8000-000000000001", callsign: "nova", display_name: "Nova", avatar_url: sampleIcons.nova, x_handle: "nova_x", joined_at_ms: noon(4) },
  { id: "00000000-0000-4000-8000-000000000002", callsign: "kofimensah", display_name: "Kofi Mensah", avatar_url: null, x_handle: null, joined_at_ms: noon(11) },
  { id: "00000000-0000-4000-8000-000000000003", callsign: null, display_name: "Legacy member", avatar_url: null, x_handle: null, joined_at_ms: noon(240) },
  { id: "00000000-0000-4000-8000-000000000004", callsign: null, display_name: null, avatar_url: null, x_handle: "quiet_one", joined_at_ms: noon(1) },
];

/* ---------- Competitions: Prize pool, Traders, Your rank ---------- */

export const COMPETITION: Competition = {
  slug: "wal-volume-sprint", name: "WAL Volume Sprint",
  coin_type: "0x356a26eb9e012a68958082340d4c4116e7f55615cf27affcff209cf0ae544f59::wal::WAL", coin_symbol: "WAL",
  feature_on_swap: false, coin_icon_url: null, prize_description: "25,000 WAL", prize_amount: null, prize_coin_type: null, prize_coin_symbol: null,
  rules_url: "https://x.com/blast/status/1", starts_at_ms: NOW - DAY, ends_at_ms: NOW + 3 * DAY + 6 * HOUR, rules_version: 1,
};
export const MEMBERS_TOTAL = 1_284;
export const RANK: CompetitionViewerRank = { competition: COMPETITION, member: { rank: 37 } as CompetitionViewerRank["member"], members_total: MEMBERS_TOTAL, as_of_ms: NOW, usd_basis: "input_value_at_submission" };

/* ---------- Portfolio: every holding read, some unpriced, so the hero reads a priced subtotal ---------- */

export const PORTFOLIO: SocialPortfolio = {
  balances: { sui: { atoms: "412380000000", usd: "1410.34" }, usdc: { atoms: "860000000", usd: "860.00" } },
  positions: [], vesting: null, totals: null, trend: null, prices_as_of_ms: null, unavailable: [],
  commitments: { committed_usd: "850.00", claimable_usd: null, known_claimable_usd: "40.00" },
  coins: [
    { coin_type: proofCoinTypes.KSTL, symbol: "KSTL", balance: "649500000000000", value_usd: "1390.00", ...NO_COST_BASIS },
    { coin_type: proofCoinTypes.LUMN, symbol: "LUMN", balance: "12000000000000", value_usd: null, ...NO_COST_BASIS },
  ],
} as SocialPortfolio;
export const PORTFOLIO_COINS: readonly HoldingCoin[] = [
  { key: "sui", name: "SUI", symbol: "SUI", presaleId: null, icon: "/blast-ui/coins/sui.svg", round: true, usd: 1410.34, quantity: 412.38 },
  { key: proofCoinTypes.KSTL, name: "Kestrel", symbol: "KSTL", presaleId: null, icon: sampleIcons.kstl, round: false, usd: 1390, quantity: 649_500 },
  { key: "usdc", name: "USDC", symbol: "USDC", presaleId: null, icon: "/blast-ui/coins/usdc.svg", round: true, usd: 860, quantity: 860 },
  { key: proofCoinTypes.LUMN, name: "Lumen", symbol: "LUMN", presaleId: null, icon: sampleIcons.lumn, round: false, usd: null, quantity: 12_000 },
];
