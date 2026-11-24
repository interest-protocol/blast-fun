import { fixtureList } from "../../../../../../packages/core/test/fixtures/presale-pages/presale-fixtures.ts";
import { presaleListQuery } from "#web/components/social/queries.ts";
import { PRESALE_LIST_SORTS } from "@blast/core/modules/social/contracts/presales.ts";
import { ENDED_SALES_LIMIT } from "#web/components/social/post/coin-moves.tsx";
import { SUI_COIN_TYPE } from "@blast/core/lib/sui/coin-types.ts";
import { queryKeys } from "#web/lib/query/keys.ts";
import type { SocialFeedPage } from "@blast/core/modules/social/contracts/feed.ts";
import type { FeedItem, FeedItemActor, FeedItemPresale } from "../../../../../../packages/core/src/modules/social/contracts/items.ts";

import { feedItem, fixturePresale } from "../feed-fixtures.ts";
import { coinMovesOf, type CoinMoves } from "#web/components/social/post/coin-moves-model.ts";
import { hex } from "../../../../../../packages/core/test/kit.ts";

/**
 * oa41's trade posts (R3-83) as feed items, for the development fixture
 * (`/dev/social/feed?story=trades`) and the tests, never production: the
 * gate's buys and the sell of launched sale coins, newest first, with the
 * gate's sample prices and today's moves (its `MKT`, `TR` and added sales
 * Nimbus, Ferro and Quarry are sample data the product never ships; here they
 * only let the fixture be compared with the gate). Times count back from
 * `nowMs`. Nobody has bought through a trade post yet (no trade intent
 * exists), so every item's through count is zero, as the product reads it.
 */

const MIN = 60_000;
const HOUR = 60 * MIN;
const ASSETS = "https://design-assets.blast.fun";

type Sale = Readonly<{ key: string; id: string; symbol: string; name: string; price: string }>;

/** The gate's trading sales: Kestrel and Lumen (the design story's ids), Nimbus, Ferro and Quarry (oa41's sample sales). */
export const TRADE_STORY_SALES = {
  kstl: { key: "kstl", id: hex("de5191a1"), symbol: "KSTL", name: "Kestrel", price: "0.0021" },
  lumn: { key: "lumn", id: hex("de5191a3"), symbol: "LUMN", name: "Lumen", price: "0.0013" },
  nimb: { key: "nimb", id: hex("de5191b0"), symbol: "NIMB", name: "Nimbus", price: "0.0031" },
  ferr: { key: "ferr", id: hex("de5191b1"), symbol: "FERR", name: "Ferro", price: "0.00142" },
  qrry: { key: "qrry", id: hex("de5191b2"), symbol: "QRRY", name: "Quarry", price: "0.00029" },
} as const satisfies Record<string, Sale>;

export function tradeStoryPresale(sale: Sale, nowMs: number): FeedItemPresale {
  return fixturePresale({
    presale_id: sale.id, symbol: sale.symbol, name: sale.name, icon_url: `${ASSETS}/mk-${sale.key}.svg`, lifecycle: "migrated",
    start_ms: nowMs - 30 * 24 * HOUR, end_ms: nowMs - 26 * 24 * HOUR, raise_target: "250000000000", raised: "250000000000",
    market: { presale_price_usd: "0.0005", price_usd: sale.price, price_as_of_ms: nowMs - 5_000, multiple: null },
  });
}

/** The gate's accounts as named actors: [account key, callsign, name, verified]. */
const PEOPLE = {
  luca: ["lucaromano", "Luca Romano", true],
  mira: ["mirachen", "Mira Chen", true],
  theo: ["theopark", "Theo Park", false],
  ana: ["anasouza", "Ana Souza", true],
  omar: ["omarhaddad", "Omar Haddad", false],
  ivy: ["ivylaurent", "Ivy Laurent", true],
  sam: ["samokafor", "Sam Okafor", false],
  nadia: ["nadiapetrova", "Nadia Petrova", false],
} as const;

function person(key: keyof typeof PEOPLE): FeedItemActor {
  const [callsign, name, verified] = PEOPLE[key];
  return { type: "account", callsign, display_name: name, avatar_url: `${ASSETS}/av-${key}.webp`, x_handle: verified ? callsign : null, verified, path: `/@${callsign}` };
}

const BIG_BUYER = `0x7c1e${"0".repeat(56)}a93b`;

/** One trade: `usd` dollars of `sale`'s coin at `at` dollars a coin (9 decimals). */
export function tradeStoryItem(
  input: Readonly<{ n: number; side: "buy" | "sell"; actor: FeedItemActor; sale: Sale; usd: number; at: number; agoMs: number; nowMs: number; rockets: number; why?: string; big?: boolean }>,
): FeedItem {
  const presale = tradeStoryPresale(input.sale, input.nowMs);
  return feedItem({
    entry_id: `a:${7000 - input.n}:1:0:0`,
    kind: input.side === "buy" ? "trade_buy" : "trade_sell",
    occurred_at_ms: input.nowMs - input.agoMs,
    presale,
    actor: input.actor,
    amounts: { quote: String(input.usd * 1e6), quote_symbol: null, quote_decimals: null, usd: input.usd.toFixed(2), tokens: String(Math.round((input.usd / input.at) * 1e9)), quote_refund: null },
    presale_post: input.big ?? false,
    big: input.big ?? false,
    why: input.why ? { why_id: `00000000-0000-4000-8000-${String(7000 + input.n).padStart(12, "0")}`, text: input.why } : null,
    reactions: { rocket: input.rockets },
    through: { people: 0, volume_usd: "0.00" },
    do_the_same: { kind: "buy", enabled: false, label: "View presale", href: `/presale/${presale.presale_id}` },
  });
}

/** oa41's trade posts in the feed's order (its `mp({ kind: 'buy' | 'bigbuy' | 'sell' })` posts of sale coins). */
export function tradeStoryItems(nowMs: number): readonly FeedItem[] {
  const S = TRADE_STORY_SALES;
  const t = (n: number, side: "buy" | "sell", actor: FeedItemActor, sale: Sale, usd: number, at: number, agoMs: number, rockets: number, extra: Readonly<{ why?: string; big?: boolean }> = {}) =>
    tradeStoryItem({ n, side, actor, sale, usd, at, agoMs, nowMs, rockets, ...extra });
  return [
    t(1, "buy", person("luca"), S.kstl, 8400, 0.0019, 9 * MIN, 64, { why: "Intents volume doubled this week. Adding to my presale bag." }),
    t(2, "buy", { type: "address", address: BIG_BUYER, short: "0x7c1e…a93b" }, S.nimb, 24800, 0.003, 12 * MIN, 18, { big: true }),
    t(3, "buy", person("nadia"), S.nimb, 400, 0.003, 25 * MIN, 9),
    t(4, "buy", person("omar"), S.nimb, 1200, 0.0029, 50 * MIN, 23, { why: "Backed it in the presale, buying more now. Every game studio I talk to wants gasless wallets." }),
    t(5, "buy", person("ivy"), S.kstl, 350, 0.00205, 70 * MIN, 5),
    t(6, "buy", person("ana"), S.ferr, 2500, 0.00131, 80 * MIN, 19, { why: "Merchants are live in three countries now. Small fees, real revenue." }),
    t(7, "buy", person("sam"), S.qrry, 220, 0.00029, 2.2 * HOUR, 3, { why: "Buying the dip. The royalties still pay out every month." }),
    t(8, "buy", person("mira"), S.nimb, 600, 0.0026, 3.2 * HOUR, 14),
    t(9, "sell", person("theo"), S.lumn, 1100, 0.0013, 4 * HOUR, 6, { why: "Taking the loss on Lumen and moving it to Nimbus." }),
  ];
}

export function tradeStoryPage(nowMs: number): SocialFeedPage {
  return { items: tradeStoryItems(nowMs), next_cursor: null, as_of: { checkpoint: 40_000, timestamp_ms: nowMs - 1_000, lag_ms: 1_000 } };
}

/** The gate's moves today (`MKT[k].ch`) by sale id, and SUI's: Nimbus the top gainer, then Kestrel, Ferro and SUI. */
export const TRADE_STORY_MOVES: CoinMoves = coinMovesOf(
  new Map([
    [TRADE_STORY_SALES.nimb.id, 32.6],
    [TRADE_STORY_SALES.kstl.id, 18.4],
    [TRADE_STORY_SALES.ferr.id, 6.2],
    ["sui", 2.41],
    [TRADE_STORY_SALES.lumn.id, -3.1],
    [TRADE_STORY_SALES.qrry.id, -8.4],
  ]),
);

/** Development prices enter through the normal query cache. */
export function seedTradeStoryPrices(client: import("@tanstack/react-query").QueryClient) {
  const sales = Object.values(TRADE_STORY_SALES);
  client.setQueryData(presaleListQuery({status: "ended", sort: PRESALE_LIST_SORTS.ended[0], limit: ENDED_SALES_LIMIT}).queryKey, {...fixtureList("ended", "recent"), presales: sales.map(sale => ({...fixtureList("ended", "recent").presales[0]!, presale_id: sale.id, name: sale.name, symbol: sale.symbol, phase: "trading" as const}))});
  client.setQueryData(queryKeys.prices.batch("24h", sales.map(sale => sale.id).join(",")), {prices: sales.map(sale => ({presale_id: sale.id, change_24h_bps: (TRADE_STORY_MOVES.change.get(sale.id) ?? 0) * 100}))});
  client.setQueryData(queryKeys.prices.history(`coin:${SUI_COIN_TYPE}`, "24h"), {presale_id: null, coin_type: SUI_COIN_TYPE, change_24h_bps: (TRADE_STORY_MOVES.change.get("sui") ?? 0) * 100, points: []});
}
