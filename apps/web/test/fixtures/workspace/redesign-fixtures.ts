/**
 * Sample data for the Blast mode redesign proof page (`/redesign-proof`).
 * Every person, coin and amount here is invented for visual review: the
 * shapes are the production contracts, the values are not market data.
 */
import type { FeedItemActor } from "@blast/core/modules/social/contracts/items.ts";
import type { HomeActivityStreamPage, HomeCoin, HomeEvent, HomeParticipant, HomeThreadPage, HomeTopHolders, HomeTrader, HomeTradersPage } from "@blast/core/modules/social/contracts/home.ts";
import type { SocialPresaleDetail, SocialPresalePerson, SocialPresaleViewerEntry } from "@blast/core/modules/social/contracts/presales.ts";
import type { SocialPriceHistory } from "@blast/core/modules/social/contracts/prices.ts";
import type { HomeCoinMarket, HomeMarketWindow } from "@blast/core/modules/social/contracts/coin-market.ts";
import type { CoinRecord } from "../../../src/components/social/blast-mode/workspace/panels/coin-reads.ts";
import { homeCoinRows } from "./coin-fixtures";
import { presaleDetail } from "./presale-fixtures";

export const sampleIcons = {
  "kstl": "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCA0OCA0OCI+PHJlY3Qgd2lkdGg9IjQ4IiBoZWlnaHQ9IjQ4IiBmaWxsPSIjRkY4QTNEIi8+PHBhdGggZD0iTTkgMjljNi0xIDEwLTQgMTQtMTAgMiA1IDYgOCAxNiA4LTYgNC0xMiA1LTE3IDRsLTYgNyAxLTdjLTMgMC02LTEtOC0yeiIgZmlsbD0iI2ZmZiIvPjxjaXJjbGUgY3g9IjMwIiBjeT0iMjIiIHI9IjEuNiIgZmlsbD0iIzdBMkUwMCIvPjwvc3ZnPg==",
  "lumn": "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCA0OCA0OCI+PHJlY3Qgd2lkdGg9IjQ4IiBoZWlnaHQ9IjQ4IiBmaWxsPSIjRkZDODNEIi8+PGNpcmNsZSBjeD0iMjQiIGN5PSIyNCIgcj0iOCIgZmlsbD0iI2ZmZiIvPjxnIHN0cm9rZT0iI2ZmZiIgc3Ryb2tlLXdpZHRoPSIzIiBzdHJva2UtbGluZWNhcD0icm91bmQiPjxwYXRoIGQ9Ik0yNCA4djRNMjQgMzZ2NE04IDI0aDRNMzYgMjRoNE0xMi43IDEyLjdsMi44IDIuOE0zMi41IDMyLjVsMi44IDIuOE0xMi43IDM1LjNsMi44LTIuOE0zMi41IDE1LjVsMi44LTIuOCIvPjwvZz48L3N2Zz4=",
  "nova": "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCA0OCA0OCI+PHJlY3Qgd2lkdGg9IjQ4IiBoZWlnaHQ9IjQ4IiBmaWxsPSIjN0M1Q0ZGIi8+PHBhdGggZD0iTTI0IDhjMS42IDkgNi40IDEzLjkgMTYgMTYtOS42IDIuMS0xNC40IDctMTYgMTYtMS42LTktNi40LTEzLjktMTYtMTYgOS42LTIuMSAxNC40LTcgMTYtMTZ6IiBmaWxsPSIjZmZmIi8+PC9zdmc+",
  "orbt": "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCA0OCA0OCI+PHJlY3Qgd2lkdGg9IjQ4IiBoZWlnaHQ9IjQ4IiBmaWxsPSIjMEZBMzk0Ii8+PGNpcmNsZSBjeD0iMjQiIGN5PSIyNCIgcj0iOC41IiBmaWxsPSIjZmZmIi8+PGVsbGlwc2UgY3g9IjI0IiBjeT0iMjQiIHJ4PSIxNyIgcnk9IjYiIGZpbGw9Im5vbmUiIHN0cm9rZT0iI2ZmZiIgc3Ryb2tlLXdpZHRoPSIyLjYiIHRyYW5zZm9ybT0icm90YXRlKC0yNCAyNCAyNCkiLz48L3N2Zz4=",
  "mochi": "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCA0OCA0OCI+PHJlY3Qgd2lkdGg9IjQ4IiBoZWlnaHQ9IjQ4IiBmaWxsPSIjRkZCM0NGIi8+PHBhdGggZD0iTTEwIDMxYzAtOSA2LTE2IDE0LTE2czE0IDcgMTQgMTZjMCAzLTMgNS0xNCA1cy0xNC0yLTE0LTV6IiBmaWxsPSIjZmZmIi8+PGNpcmNsZSBjeD0iMTkiIGN5PSIyNyIgcj0iMS44IiBmaWxsPSIjNUEyQTNBIi8+PGNpcmNsZSBjeD0iMjkiIGN5PSIyNyIgcj0iMS44IiBmaWxsPSIjNUEyQTNBIi8+PHBhdGggZD0iTTIyIDMxcTIgMiA0IDAiIHN0cm9rZT0iIzVBMkEzQSIgc3Ryb2tlLXdpZHRoPSIxLjYiIGZpbGw9Im5vbmUiIHN0cm9rZS1saW5lY2FwPSJyb3VuZCIvPjwvc3ZnPg==",
  "frog": "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCA0OCA0OCI+PHJlY3Qgd2lkdGg9IjQ4IiBoZWlnaHQ9IjQ4IiBmaWxsPSIjMkZCNDVBIi8+PGNpcmNsZSBjeD0iMTYiIGN5PSIxOSIgcj0iNiIgZmlsbD0iI2ZmZiIvPjxjaXJjbGUgY3g9IjMyIiBjeT0iMTkiIHI9IjYiIGZpbGw9IiNmZmYiLz48Y2lyY2xlIGN4PSIxNiIgY3k9IjE5IiByPSIyLjYiIGZpbGw9IiMwRTNCMUUiLz48Y2lyY2xlIGN4PSIzMiIgY3k9IjE5IiByPSIyLjYiIGZpbGw9IiMwRTNCMUUiLz48cGF0aCBkPSJNMTMgMzFxMTEgOCAyMiAwIiBzdHJva2U9IiNmZmYiIHN0cm9rZS13aWR0aD0iMyIgZmlsbD0ibm9uZSIgc3Ryb2tlLWxpbmVjYXA9InJvdW5kIi8+PC9zdmc+",
  "tide": "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCA0OCA0OCI+PHJlY3Qgd2lkdGg9IjQ4IiBoZWlnaHQ9IjQ4IiBmaWxsPSIjMkY3QkY1Ii8+PHBhdGggZD0iTTggMjhjNC02IDgtNiAxMiAwczggNiAxMiAwIDYtNSA4LTNNOCAzNmM0LTYgOC02IDEyIDBzOCA2IDEyIDAgNi01IDgtMyIgc3Ryb2tlPSIjZmZmIiBzdHJva2Utd2lkdGg9IjMiIGZpbGw9Im5vbmUiIHN0cm9rZS1saW5lY2FwPSJyb3VuZCIvPjxjaXJjbGUgY3g9IjMxIiBjeT0iMTUiIHI9IjQiIGZpbGw9IiNmZmYiLz48L3N2Zz4=",
  "embr": "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCA0OCA0OCI+PHJlY3Qgd2lkdGg9IjQ4IiBoZWlnaHQ9IjQ4IiBmaWxsPSIjRTg0ODNCIi8+PHBhdGggZD0iTTI0IDljMiA3IDEwIDEwIDEwIDE5YTEwIDEwIDAgMCAxLTIwIDBjMC01IDMtNyA0LTExIDIgMyAzIDQgNSA0LTItNC0xLTggMS0xMnoiIGZpbGw9IiNmZmYiLz48cGF0aCBkPSJNMjQgMjZjMSAzIDQgNCA0IDdhNCA0IDAgMCAxLTggMGMwLTMgMy00IDQtN3oiIGZpbGw9IiNGRkMyQTgiLz48L3N2Zz4="
} as const;

const avatars = {
  "mara": "data:image/png;base64,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",
  "kofi": "data:image/png;base64,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",
  "ines": "data:image/png;base64,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",
  "dev": "data:image/png;base64,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"
} as const;

const hex = (seed: number) => `0x${seed.toString(16).padStart(64, "0")}`;
type Person = Readonly<{ callsign: string; display_name: string | null; avatar_url: string | null; verified: boolean }>;
export const people = {
  mara: { callsign: "maralin", display_name: "Mara Lin", avatar_url: avatars.mara, verified: true },
  kofi: { callsign: "kofimensah", display_name: "Kofi Mensah", avatar_url: avatars.kofi, verified: false },
  ines: { callsign: "inesduarte", display_name: "Inês Duarte", avatar_url: avatars.ines, verified: true },
  devon: { callsign: "devonsui", display_name: "devon.sui", avatar_url: avatars.dev, verified: false },
  sora: { callsign: "sora_trades", display_name: "Sora", avatar_url: null, verified: false },
  juno: { callsign: "junopark", display_name: "Juno Park", avatar_url: null, verified: true },
} satisfies Record<string, Person>;
type Name = keyof typeof people;

export function account(name: Name): FeedItemActor {
  const person = people[name];
  return { type: "account", ...person, x_handle: person.callsign, path: `/@${person.callsign}` };
}
export function wallet(seed: number): FeedItemActor {
  const address = hex(seed * 7919 + 4099);
  return { type: "address", address, short: `${address.slice(0, 6)}…${address.slice(-4)}` };
}
export const person = (name: Name): SocialPresalePerson => people[name];

export const proofCoinTypes = {
  KSTL: `0x${"a1".repeat(32)}::kestrel::KSTL`,
  LUMN: `0x${"b2".repeat(32)}::lumen::LUMN`,
  NOVA: `0x${"c3".repeat(32)}::nova::NOVA`,
  ORBT: `0x${"d4".repeat(32)}::orbit::ORBT`,
} as const;
export const proofPresaleIds = { NOVA: hex(0x5a1e1), ORBT: hex(0x5a1e2) } as const;

const now = Date.now();
const topHolders = (names: readonly (Name | number)[], total: string): HomeTopHolders => ({
  share_bps: 3800,
  holders: names.map((entry, index) => ({
    actor: typeof entry === "number" ? wallet(entry) : account(entry),
    balance: (BigInt(total) / BigInt(index + 2)).toString(),
    share_bps: Math.round(1240 / (index + 1)),
  })),
});

export const proofCoins: Readonly<Record<"KSTL" | "LUMN", CoinRecord>> = {
  KSTL: {
    coin_type: proofCoinTypes.KSTL, symbol: "KSTL", name: "Kestrel", decimals: 9,
    price_usd: "0.002140", price_as_of_ms: now, icon_url: sampleIcons.kstl,
    change_24h_bps: 1240, fdv_usd: "21400", holders: 284, lifecycle: "migrated", venue: "cetus",
    top_holders: topHolders(["ines", 1, "mara", "juno", "devon"], "2480000000000000"),
  },
  LUMN: {
    coin_type: proofCoinTypes.LUMN, symbol: "LUMN", name: "Lumen", decimals: 9,
    price_usd: "0.0817", price_as_of_ms: now, icon_url: sampleIcons.lumn,
    change_24h_bps: -310, fdv_usd: "81700", holders: 1204, lifecycle: "migrated", venue: "bluefin",
    top_holders: topHolders(["sora", "ines", 2, "kofi", "mara"], "196000000000000"),
  },
};

export function proofHistory(coin_type: string, up: boolean): SocialPriceHistory {
  let value = 100;
  let seed = up ? 11 : 37;
  const base = up ? 0.00187 : 0.0861;
  const points = Array.from({ length: 96 }, (_, index) => {
    seed = (seed * 9301 + 49297) % 233280;
    value *= 1 + (up ? 0.0016 : -0.0007) + (seed / 233280 - 0.5) * 0.035;
    return [now - (95 - index) * 15 * 60_000, (base * value / 100).toPrecision(4)] as const;
  });
  return {
    coin_type, presale_id: null, tier: "5m", from_ms: points[0]![0], points,
    price_usd: points.at(-1)![1], price_24h_usd: points[0]![1], change_24h_bps: up ? 1240 : -310,
    day_open_usd: points[0]![1], day_open_ms: points[0]![0],
  } as SocialPriceHistory;
}

const usdc = (usd: string) => ({ quote_type: "0x2::usdc::USDC", quote_symbol: "USDC", quote_decimals: 6, atoms: String(Math.round(Number(usd) * 1e6)), usd, usd_complete: true });
let eventSeed = 0;
function trade(kind: "trade_buy" | "trade_sell", usd: string, tokens: string, minutesAgo: number): HomeEvent {
  eventSeed += 1;
  return { activity_id: `9:${eventSeed}:0:0`, entry_id: `a:9:${eventSeed}:0:0`, kind, occurred_at_ms: now - minutesAgo * 60_000, digest: null, quote: usdc(usd), tokens, refund: null, has_why: false };
}
function participant(actor: FeedItemActor, events: readonly HomeEvent[]): HomeParticipant {
  return {
    key: actor.type === "account" ? `c:${actor.callsign}` : `w:${actor.address}`,
    actor, followers: actor.type === "account" ? 120 : null, buys: null, sells: null, commits: null, claims: null,
    latest_ms: events[0]!.occurred_at_ms, latest_kind: events[0]!.kind, events_total: events.length, events,
  };
}
export function proofThread(symbol: "KSTL" | "LUMN"): HomeThreadPage {
  const rows = symbol === "KSTL"
    ? [participant(account("mara"), [trade("trade_buy", "120.00", "56100000000000", 2)]), participant(wallet(3), [trade("trade_sell", "38.20", "17900000000000", 4)]), participant(account("ines"), [trade("trade_buy", "64.50", "30200000000000", 9)]), participant(account("kofi"), [trade("trade_buy", "15.00", "7000000000000", 12)]), participant(wallet(4), [trade("trade_sell", "210.00", "98400000000000", 21)]), participant(account("juno"), [trade("trade_buy", "48.00", "22400000000000", 33)])]
    : [participant(account("kofi"), [trade("trade_buy", "84.20", "1031000000000", 1)]), participant(account("sora"), [trade("trade_sell", "412.00", "5043000000000", 3)]), participant(account("mara"), [trade("trade_sell", "56.00", "685000000000", 6)]), participant(wallet(5), [trade("trade_buy", "22.10", "270000000000", 8)]), participant(account("ines"), [trade("trade_buy", "140.00", "1714000000000", 15)])];
  const as_of = { checkpoint: 1, timestamp_ms: now - 20_000, lag_ms: 20_000 };
  const { preview, ...activity } = homeCoinRows[0]!.activity;
  void preview;
  return { presale_id: "", coin_type: null, participants: rows, totals: activity, next_cursor: null, window: "24h", clock_ms: now, as_of };
}

type Backer = Readonly<{ who: Name | number; usd: string; why: string | null; minutesAgo: number }>;
function presale(symbol: "NOVA" | "ORBT", raised: string, target: string, backers: number, rows: readonly Backer[], hoursLeft: number, venue: string, vestingDays: number | null): SocialPresaleDetail {
  const base = presaleDetail("open");
  const total = Number(raised);
  const top = rows.map((row) => ({
    wallet: typeof row.who === "number" ? wallet(row.who).type === "address" ? (wallet(row.who) as { address: string }).address : "" : hex(row.usd.length * 977 + rows.indexOf(row)),
    account: typeof row.who === "number" ? null : person(row.who),
    commitment_usd: row.usd,
    commitment_atoms: String(Math.round(Number(row.usd) * 1e6)),
    share_bps: Math.round((Number(row.usd) / total) * 10_000),
    last_commit_ms: now - row.minutesAgo * 60_000,
    why: row.why,
  }));
  const vesting = vestingDays === null ? null : { start_ms: now + hoursLeft * 3_600_000, cliff_end_ms: now + hoursLeft * 3_600_000, end_ms: now + hoursLeft * 3_600_000 + vestingDays * 86_400_000 };
  return {
    ...base,
    presale: {
      ...base.presale,
      presale_id: proofPresaleIds[symbol], sale_token: proofCoinTypes[symbol], symbol,
      name: symbol === "NOVA" ? "Nova" : "Orbit", icon_url: symbol === "NOVA" ? sampleIcons.nova : sampleIcons.orbt,
      venue, end_ms: now + hoursLeft * 3_600_000, target_usd: target, raised_usd: raised,
      target_atoms: String(Number(target) * 1e6), raised_atoms: String(Math.round(total * 1e6)),
      fill_bps: Math.round((total / Number(target)) * 10_000), participants: backers,
      presale_price_usd: symbol === "NOVA" ? "0.000111" : "0.00025", presale_price_quote: symbol === "NOVA" ? "0.000111" : "0.00025",
    },
    backers: { top, top10_bps: 3100 },
    raise: {
      points: [[now - 86_400_000, "0", "0"], [now, raised, String(Math.round(total * 1e6))]],
      markers: top.map((backer) => ({ t: backer.last_commit_ms!, raised_usd: raised, commit_usd: backer.commitment_usd!, raised_atoms: String(Math.round(total * 1e6)), commit_atoms: backer.commitment_atoms, wallet: backer.wallet, account: backer.account, why: backer.why })),
    },
    ...(vesting ? { vesting } : {}),
  } as SocialPresaleDetail;
}

export const proofPresales = {
  NOVA: presale("NOVA", "6210.00", "10000", 48, [
    { who: "juno", usd: "1000.00", why: "Biggest raise this week, fair terms", minutesAgo: 18 },
    { who: "kofi", usd: "250.00", why: "Team shipped two products already", minutesAgo: 6 },
    { who: "mara", usd: "120.00", why: "Love the vesting, no instant dump", minutesAgo: 64 },
    { who: 7, usd: "75.00", why: null, minutesAgo: 31 },
    { who: "devon", usd: "60.00", why: null, minutesAgo: 95 },
  ], 4.2, "cetus", 30),
  ORBT: presale("ORBT", "18940.00", "25000", 131, [
    { who: "ines", usd: "2500.00", why: "Orbit has the best community on Sui", minutesAgo: 2 },
    { who: 8, usd: "1200.00", why: null, minutesAgo: 44 },
    { who: "sora", usd: "400.00", why: "Early on the last two, both 5x", minutesAgo: 9 },
    { who: "mara", usd: "250.00", why: "Small bag, watching the team", minutesAgo: 70 },
  ], 54, "bluefin", null),
};

export function proofViewer(symbol: "NOVA" | "ORBT"): SocialPresaleViewerEntry {
  const followed = symbol === "NOVA" ? (["kofi", "mara", "devon"] as const) : (["mara", "sora"] as const);
  return {
    following: followed.map((name, index) => ({ account: person(name), commitment_usd: "100.00", commitment_atoms: "100000000", last_commit_ms: now - (index + 1) * 600_000, why: null, commits: [] })),
    following_total_usd: "300.00",
    following_total_atoms: "300000000",
    mine: null,
  } as SocialPresaleViewerEntry;
}

/* Data rail rows: production contracts, invented values. */

const asOf = { checkpoint: 1, timestamp_ms: now - 20_000, lag_ms: 20_000 };
function spark(up: boolean, seed: number, base: number) {
  let value = 100;
  return Array.from({ length: 24 }, (_, index) => {
    seed = (seed * 9301 + 49297) % 233280;
    value *= 1 + (up ? 0.008 : -0.006) + (seed / 233280 - 0.5) * 0.09;
    return [now - (23 - index) * 3_600_000, (base * value / 100).toPrecision(4)] as const;
  });
}
type RailCoin = Readonly<{ symbol: string; name: string; icon: string; venue: string; price: string; bps: number | null; why: string; seed: number; sale?: Readonly<{ raised: string; target: string; participants: number; hours: number }> }>;
const railBuyers: readonly (readonly Name[])[] = [["mara", "kofi", "ines"], ["devon", "sora"], ["kofi", "juno", "mara"], ["kofi"], ["juno", "ines"], ["sora"], ["juno", "kofi", "mara"], ["ines", "sora", "mara"]];
function railActivity(index: number): HomeCoin["activity"] {
  const names = railBuyers[index % railBuyers.length]!;
  const preview = names.map((name, position) => ({
    ...participant(account(name), [trade("trade_buy", "50.00", "1000000000", 3 + position * 7)]),
    buys: { count: 1, amounts: [usdc("50.00")], tokens: "1000000000", latest_ms: now - (3 + position * 7) * 60_000 },
    relation: position === 0 ? ("followed" as const) : undefined,
  }));
  const buyers = [48, 131, 22, 212, 17, 9, 48, 131][index % 8]!;
  return { ...homeCoinRows[0]!.activity, participants: buyers + 2, buyers, backers: buyers, events: buyers + 6, preview };
}
const railCoin = (coin: RailCoin, index: number): HomeCoin => ({
  ...homeCoinRows[0]!,
  presale_id: hex(0xc0f00 + index),
  coin_type: `0x${(index + 0x30).toString(16).repeat(32).slice(0, 64)}::${coin.name.toLowerCase().replace(/\W/g, "")}::${coin.symbol}`,
  symbol: coin.symbol, name: coin.name, icon_url: coin.icon, decimals: 9,
  lifecycle: coin.sale ? "open" : "migrated", venue: coin.venue, tradable: !coin.sale,
  quote: { type: "0x2::usdc::USDC", symbol: "USDC", decimals: 6 },
  sale: coin.sale ? { start_ms: now - 86_400_000, end_ms: now + coin.sale.hours * 3_600_000, raise_target: String(Number(coin.sale.target) * 1e6), raised: String(Number(coin.sale.raised) * 1e6), participants: coin.sale.participants } : null,
  price_usd: coin.price, price_as_of_ms: now, change_24h_bps: coin.bps, holders: 120 + index * 37, holders_as_of_ms: now,
  fdv_usd: (Number(coin.price) * 1e7).toFixed(2), spark: coin.sale ? [] : spark((coin.bps ?? 0) >= 0, coin.seed, Number(coin.price)),
  top_holders: topHolders(["ines", "mara", 9], "1000000000000"),
  rank: { score: 100 - index, why: coin.why },
  activity: railActivity(index),
});
export const proofHomeCoins: readonly HomeCoin[] = ([
  { symbol: "KSTL", name: "Kestrel", icon: sampleIcons.kstl, venue: "cetus", price: "0.00214", bps: 1240, why: "3 people you follow bought", seed: 11 },
  { symbol: "MOCHI", name: "Mochi", icon: sampleIcons.mochi, venue: "cetus", price: "0.0412", bps: 3100, why: "Volume up 4× today", seed: 5 },
  { symbol: "LUMN", name: "Lumen", icon: sampleIcons.lumn, venue: "bluefin", price: "0.0817", bps: -310, why: "Kofi Mensah bought $84", seed: 37 },
  { symbol: "FROG", name: "Frog Club", icon: sampleIcons.frog, venue: "cetus", price: "0.00067", bps: 820, why: "212 new holders today", seed: 19 },
  { symbol: "TIDE", name: "Tide", icon: sampleIcons.tide, venue: "bluefin", price: "0.0198", bps: 560, why: "Started trading 2h ago", seed: 23 },
  { symbol: "EMBR", name: "Ember", icon: sampleIcons.embr, venue: "cetus", price: "0.0031", bps: -940, why: "Inês Duarte sold $410", seed: 29 },
  { symbol: "NOVA", name: "Nova", icon: sampleIcons.nova, venue: "cetus", price: "0.000111", bps: null, why: "Biggest raise this week", seed: 3, sale: { raised: "6210", target: "10000", participants: 48, hours: 4.2 } },
  { symbol: "ORBT", name: "Orbit", icon: sampleIcons.orbt, venue: "bluefin", price: "0.00025", bps: null, why: "7 people you follow backed it", seed: 7, sale: { raised: "18940", target: "25000", participants: 131, hours: 54 } },
] satisfies readonly RailCoin[]).map(railCoin);

const holding = (coin: HomeCoin, usd: string, pnl: string) => ({ presale_id: coin.presale_id!, symbol: coin.symbol, icon_url: coin.icon_url, decimals: 9, balance: "1240000000000", value_usd: usd, share_bps: 120, pnl_usd: pnl });
const coinTouch = (coin: HomeCoin, minutesAgo: number) => ({ presale_id: coin.presale_id!, symbol: coin.symbol, icon_url: coin.icon_url, decimals: 9, buys: { count: 1, amounts: [usdc("50.00")], tokens: "1000000000", latest_ms: now - minutesAgo * 60_000 }, sells: null, commits: null, claims: null, latest_ms: now - minutesAgo * 60_000 });
function trader(actor: FeedItemActor, rank: number, pnl: string, value: string, coins: readonly HomeCoin[]): HomeTrader {
  const event = trade("trade_buy", "50.00", "1000000000", rank * 7);
  return {
    ...participant(actor, [event]), rank,
    portfolio: { public: true, value_usd: value, pnl_usd: pnl },
    holdings_public: true, performance_public: true,
    holdings: coins.map((coin) => holding(coin, (Number(value) / coins.length).toFixed(2), (Number(pnl) / coins.length).toFixed(2))),
    holdings_total: coins.length,
    coins: coins.map((coin, index) => coinTouch(coin, rank * 7 + index)), coins_total: coins.length,
  } as HomeTrader;
}
const [kstl, mochi, lumn, frog, tide, embr, nova, orbt] = proofHomeCoins as [HomeCoin, HomeCoin, HomeCoin, HomeCoin, HomeCoin, HomeCoin, HomeCoin, HomeCoin];
export const proofTraders: HomeTradersPage = {
  search: "", page: 1, limit: 7, total: 7, global_total: 7, window: "24h", clock_ms: now, as_of: asOf,
  traders: [
    trader(account("ines"), 1, "4820.00", "12640.00", [kstl, orbt, lumn]),
    trader(account("juno"), 2, "2104.00", "9800.00", [nova, kstl]),
    trader(account("mara"), 3, "1240.00", "6812.00", [kstl, lumn, nova]),
    trader(account("sora"), 4, "980.00", "8150.00", [mochi, lumn]),
    trader(account("kofi"), 5, "612.00", "6510.00", [frog, lumn, tide]),
    trader(account("devon"), 6, "305.00", "7430.00", [embr, kstl]),
    trader(wallet(11), 7, "290.00", "7630.00", [kstl]),
  ],
};

function streamEvent(actor: FeedItemActor, coin: HomeCoin, kind: "trade_buy" | "trade_sell" | "presale_commit", usd: string, tokens: string | null, minutesAgo: number) {
  eventSeed += 1;
  return {
    activity_id: `8:${eventSeed}:0:0`, entry_id: `a:8:${eventSeed}:0:0`, kind, occurred_at_ms: now - minutesAgo * 60_000, digest: null,
    quote: usdc(usd), tokens, refund: null, has_why: false, actor,
    coin: { chain: "sui" as const, network: "mainnet" as const, coin_type: coin.coin_type, presale_id: coin.presale_id, lifecycle: coin.lifecycle, decimals: 9, symbol: coin.symbol, name: coin.name, icon_url: coin.icon_url },
  };
}
export const proofActivity: HomeActivityStreamPage = {
  window: "24h", from_ms: now - 86_400_000, to_ms: now, clock_ms: now, next_cursor: null, as_of: asOf,
  events: [
    streamEvent(account("kofi"), lumn, "trade_buy", "84.20", "1031000000000", 1),
    streamEvent(account("mara"), kstl, "trade_buy", "120.00", "56100000000000", 2),
    streamEvent(account("ines"), orbt, "presale_commit", "2500.00", null, 2),
    streamEvent(account("sora"), lumn, "trade_sell", "412.00", "5043000000000", 3),
    streamEvent(account("juno"), nova, "presale_commit", "1000.00", null, 18),
    streamEvent(wallet(4), kstl, "trade_sell", "210.00", "98400000000000", 21),
    streamEvent(account("devon"), mochi, "trade_buy", "150.00", "3640000000000", 24),
    streamEvent(account("kofi"), frog, "trade_buy", "50.00", "74600000000000", 40),
    streamEvent(account("juno"), tide, "trade_buy", "75.00", "3780000000000", 52),
    // Worst case for the row (audit F34): a whale sell reads compact, exact on inspect.
    streamEvent(account("ines"), embr, "trade_sell", "1234567.89", "99312456789012345", 66),
  ],
};

/* "Who's buying" for the coin cards: the Discover row's activity window with followed buyers first. */
function buyers(names: readonly Name[], count: number) {
  const base = homeCoinRows[0]!.activity;
  const preview = names.map((name, index) => ({
    ...participant(account(name), [trade("trade_buy", "50.00", "1000000000", 5 + index * 9)]),
    buys: { count: 1, amounts: [usdc("50.00")], tokens: "1000000000", latest_ms: now - (5 + index * 9) * 60_000 },
    relation: index < 2 ? ("followed" as const) : undefined,
  }));
  return { ...base, participants: count + 3, buyers: count, events: count + 9, preview };
}
Object.assign(proofCoins.KSTL, { activity: buyers(["mara", "kofi", "sora"], 48) });
Object.assign(proofCoins.LUMN, { activity: buyers(["kofi", "ines", "juno"], 131) });

/* The coin market read (the Flow card and the coin header): every window's move and both sides, all venues. */
const marketWindow = (minutes: number, move: string, bps: number, sides: Readonly<{ buys: number; sells: number; bought: string; sold: string; buyers: number; sellers: number }>): HomeMarketWindow => ({
  from_ms: now - minutes * 60_000, to_ms: now, open_usd: "0.3990", open_as_of_ms: now - minutes * 60_000, change_bps: bps, change_usd: move,
  buys: sides.buys, sells: sides.sells, bought_atoms: "0", sold_atoms: "0", bought_usd: sides.bought, sold_usd: sides.sold,
  unpriced_buys: 0, unpriced_sells: 0, buyers: sides.buyers, sellers: sides.sellers,
});
export function proofMarket(coinType: string): HomeCoinMarket {
  return {
    coin_type: coinType, presale_id: null, decimals: 9, quote: { type: "0x2::sui::SUI", symbol: "SUI", decimals: 9 }, clock_ms: now,
    price_usd: "0.4127", price_as_of_ms: now,
    windows: {
      "5m": marketWindow(5, "0.0006", 15, { buys: 41, sells: 22, bought: "9120.00", sold: "4310.00", buyers: 30, sellers: 18 }),
      "1h": marketWindow(60, "0.0086", 213, { buys: 312, sells: 140, bought: "71200.00", sold: "33800.00", buyers: 188, sellers: 92 }),
      "4h": marketWindow(240, "0.0166", 418, { buys: 980, sells: 411, bought: "212000.00", sold: "101000.00", buyers: 540, sellers: 238 }),
      "24h": marketWindow(1_440, "0.0137", 342, { buys: 1_708, sells: 735, bought: "380000.00", sold: "181000.00", buyers: 941, sellers: 410 }),
    },
    supply: { total: "5000000000000000000", escrowed: "1000000000000000000", circulating: "4000000000000000000" },
    fdv_usd: "2063500000.00", market_cap_usd: "1650800000.00",
    pool: { id: hex(0x9001), venue: "cetus", coin_atoms: "11400000000000000", quote_atoms: "4710000000000000", as_of_ms: now - 40_000 },
    liquidity_usd: "9420000.00", as_of: asOf,
  };
}

/* The launchpad's curves for Discover's Bonding tab, by stage. */
const SUI_TYPE = "0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI";
const curve = (tag: number, symbol: string, name: string | null, fields: Record<string, unknown>) => {
  const launchId = hex(0xc0e00 + tag);
  return { launchId, coinType: `${launchId}::${symbol.toLowerCase()}::${symbol}`, quoteType: SUI_TYPE, lifecycle: "live", name, symbol, iconUrl: null, createdAtMs: now - tag * 47 * 60_000, graduatedAtMs: null, quoteRemaining: "1250000000000", quoteDecimals: 9, progressBps: 2_400 + tag * 700, partner: null, ...fields };
};
export function proofBonding(view: string) {
  const provenance = { source: "blast-infra", network: "mainnet", deployment: "proof", checkpoint: 7, timestampMs: now, observedAt: now, lagMs: 0 };
  const rows = view === "graduated"
    ? [curve(1, "PEPU", "Pepu", { lifecycle: "migrated", progressBps: 10_000, quoteRemaining: "0", graduatedAtMs: now - 2 * 3_600_000 }), curve(2, "HALO", "Halo", { lifecycle: "migrated", progressBps: 10_000, quoteRemaining: "0", graduatedAtMs: now - 26 * 3_600_000 })]
    : view === "near_graduation"
      ? [curve(9, "MOCHI", "Mochi", { progressBps: 9_420, quoteRemaining: "184000000000" }), curve(8, "FERN", "Fern", { progressBps: 8_810, quoteRemaining: "402000000000" }), curve(7, "TIDE", null, { progressBps: 8_015, quoteRemaining: null })]
      : [curve(1, "FROG", "Froggy", {}), curve(2, "ZAP", "Zap Zap", {}), curve(3, "NIMBUS", "Nimbus Cloud Coin", { progressBps: null }), curve(4, "ORCA", "Orca", {}), curve(5, "LILY", null, {})];
  return { view, section: { state: "available", data: { rows, nextCursor: view === "new" ? "proof-page-2" : null }, provenance } };
}
